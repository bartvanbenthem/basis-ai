// Package modelgateway composes a ModelGateway (ai.cndev.nl/v1alpha1): one
// OpenAI-compatible entry point to a Project's models, on Agent Router, in
// its protected site and optionally a standby in its recovery site.
//
// On the control plane, next to the XR:
//
//	keys               Secret <name>-keys: an API key per spec.clients entry,
//	                   generated once, then kept; a removed client's key goes
//
// In each site's location (provider-kubernetes Objects, prefix "<site>-"):
//
//	envoyproxy,        Agent Router on Envoy Gateway: an internal (ClusterIP)
//	gateway,           Service <name>, client API key auth, and an
//	clienttraffic,     AIGatewayRoute routing on the request's model to a
//	backendtraffic,    backend per spec.models entry; 50Mi buffers for
//	keys,              requests and responses
//	securitypolicy,    (model-<hash>-{backend,aiservicebackend,tls,apikey,
//	route, model-...   backendsecurity})
//
// With spec.expose, next to those in each site:
//
//	certificate,       a cert-manager Certificate <name>-tls for the hostname
//	external-envoyproxy, from the ClusterIssuer spec.expose.issuer, and a Gateway
//	external-gateway   <name>-external of its own: HTTPS only, on a LoadBalancer
//	                   Service <name>-external limited to the source ranges. The
//	                   route and the client key auth cover both Gateways; the
//	                   internal one stays plain HTTP, in-cluster only.
//
// The active site (spec.activeSite) gets spec.replicas, the standby
// spec.recovery.replicas.
package modelgateway

import (
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // names, not a security boundary
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// GatewayClass the Gateways use: Envoy Gateway's, created per location by
// deps/ (see deps/README.md).
const GatewayClass = "basis-ai"

// RequiredProject is the Project the gateway's sites come from.
const RequiredProject = "project"

type Object = map[string]any

// Requirement is a resource the composition needs to see; Namespace empty
// for a cluster-scoped one.
type Requirement struct {
	APIVersion, Kind, Namespace, Name string
}

// Requirements: the Project (its sites).
func Requirements(namespace string) map[string]Requirement {
	return map[string]Requirement{RequiredProject: {"platform.cndev.nl/v1alpha1", "Project", "", namespace}}
}

type Input struct {
	XR       Object
	Observed map[string]Object
	Required map[string][]Object
}

type Composed struct {
	Object Object
	Ready  bool
}

type Condition struct {
	Status  bool
	Reason  string
	Message string
}

type SiteStatus struct {
	Site     string `json:"site"`
	Location string `json:"location"`
	Active   bool   `json:"active"`
	Replicas int    `json:"replicas"`
	// Address is the external LoadBalancer's, once it has one.
	Address string `json:"address,omitempty"`
}

type Status struct {
	Ready      bool   `json:"ready"`
	Message    string `json:"message"`
	ActiveSite string `json:"activeSite"`
	Models     int    `json:"models"`
	Clients    int    `json:"clients"`
	Endpoint   string `json:"endpoint"`
	// ExternalEndpoint is the base URL from outside the location (spec.expose).
	ExternalEndpoint string       `json:"externalEndpoint,omitempty"`
	KeysSecret       string       `json:"keysSecret"`
	Sites            []SiteStatus `json:"sites"`
}

type Output struct {
	Composed  map[string]Composed
	Status    Status
	Condition Condition
}

// NewKey generates client API keys; tests replace it.
var NewKey = func() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, 40)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			panic(fmt.Sprintf("crypto/rand: %v", err))
		}
		b[i] = alphabet[n.Int64()]
	}
	return string(b)
}

// Endpoint is the base URL OpenAI clients use for gateway name in namespace,
// the same in every site's location.
func Endpoint(name, namespace string) string {
	return fmt.Sprintf("http://%s.%s.svc/v1", name, namespace)
}

// ExternalEndpoint is the base URL from outside the location at hostname.
func ExternalEndpoint(hostname string) string { return "https://" + hostname + "/v1" }

// KeysSecret is the Secret with the clients' API keys.
func KeysSecret(name string) string { return name + "-keys" }

type composition struct {
	spec     *Spec
	name, ns string
	observed map[string]Object
	labels   map[string]string
}

// Compose renders the desired state of a ModelGateway.
func Compose(in Input) (*Output, error) {
	var xr XR
	decode(in.XR, &xr)
	c := &composition{spec: &xr.Spec, name: xr.Metadata.Name, ns: xr.Metadata.Namespace, observed: in.Observed}
	c.labels = map[string]string{
		"app.kubernetes.io/managed-by": "crossplane",
		"app.kubernetes.io/part-of":    "basis",
		"ai.cndev.nl/modelgateway":     c.name,
	}
	// Owned by a GenAIStack: the same label on everything it composes, so
	// the stack's objects are found together.
	if stack := xr.Metadata.Labels["ai.cndev.nl/genaistack"]; stack != "" {
		c.labels["ai.cndev.nl/genaistack"] = stack
	}
	spec := c.spec
	out := &Output{Composed: map[string]Composed{}}

	// ---- sites: pinned in status.sites, else the Project's locations
	var project Object
	if p := in.Required[RequiredProject]; len(p) > 0 {
		project = p[0]
	}
	pinned := map[string]string{}
	for _, s := range xr.Status.Sites {
		pinned[s.Site] = s.Location
	}
	location := func(s string) string {
		l, _ := dig(project, "spec", "locations", s).(string)
		return or(pinned[s], l)
	}
	active := spec.activeSite()
	sites := []string{SiteProtected}
	if spec.Recovery.Enabled {
		sites = append(sites, SiteRecovery)
	}

	// ---- control plane: a key per client
	keys := map[string]string{}
	for _, cl := range spec.clients() {
		keys[cl] = b64(c.keep("keys", cl))
	}
	out.Composed["keys"] = Composed{Ready: c.observed["keys"] != nil, Object: Object{
		"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
		"metadata": c.meta(KeysSecret(c.name)),
		// Envoy Gateway API key auth: a key per client id.
		"data": keys,
	}}

	status := Status{ActiveSite: active, Models: len(spec.Models), Clients: len(keys),
		Endpoint: Endpoint(c.name, c.ns), KeysSecret: KeysSecret(c.name), Sites: []SiteStatus{}}
	if spec.exposed() {
		status.ExternalEndpoint = ExternalEndpoint(spec.Expose.Hostname)
	}
	var problems, external []string
	allReady := out.Composed["keys"].Ready
	for _, s := range sites {
		replicas := spec.standbyReplicas()
		if s == active {
			replicas = spec.replicas()
		}
		loc := location(s)
		ss := SiteStatus{Site: s, Location: loc, Active: s == active, Replicas: replicas}
		if loc == "" {
			status.Sites = append(status.Sites, ss)
			problems = append(problems, fmt.Sprintf("Project %s has no %s location (spec.locations.%s)", c.ns, s, s))
			allReady = false
			continue
		}
		objects, err := c.siteObjects(replicas)
		if err != nil {
			return nil, err
		}
		internalReady := true
		for key, o := range objects {
			k := s + "-" + key
			w := c.wrap(k, loc, o.manifest, o.copyFrom)
			w.Ready = o.ready(c.observed[k])
			out.Composed[k] = w
			allReady = allReady && w.Ready
			if !strings.HasPrefix(key, "external-") && key != "certificate" {
				internalReady = internalReady && w.Ready
			}
		}
		if spec.exposed() {
			addrs, _ := dig(live(c.observed[s+"-external-gateway"]), "status", "addresses").([]any)
			if len(addrs) > 0 {
				ss.Address, _ = dig(addrs[0], "value").(string)
			}
			// Only once Agent Router runs: then what's missing is outside it.
			if internalReady {
				if !liveReady(c.observed[s+"-certificate"], "Ready") {
					external = append(external, fmt.Sprintf("certificate %s-tls in %s (cert-manager ClusterIssuer %s)", c.name, loc, spec.Expose.issuer()))
				}
				if ss.Address == "" {
					external = append(external, fmt.Sprintf("a LoadBalancer address in %s", loc))
				}
			}
		}
		status.Sites = append(status.Sites, ss)
	}

	status.Ready = allReady
	cond := Condition{Status: allReady, Reason: "Available"}
	switch {
	case len(problems) > 0:
		status.Message = strings.Join(problems, "; ")
		cond.Reason = "Waiting"
	case !allReady && len(external) > 0:
		status.Message = "Waiting for the external endpoint: " + strings.Join(external, ", ")
		cond.Reason = "Creating"
	case !allReady:
		status.Message = "Waiting for Agent Router in the location(s)"
		cond.Reason = "Creating"
	case len(spec.Models) == 0:
		status.Message = fmt.Sprintf("Gateway %s is ready, without models: add some to spec.models", c.name)
	default:
		status.Message = fmt.Sprintf("Gateway %s is ready with %d model(s); active site %s", c.name, len(spec.Models), active)
	}
	cond.Message = status.Message
	out.Status, out.Condition = status, cond
	return out, nil
}

// object is a manifest for a location, with how to tell it's ready.
type object struct {
	manifest Object
	copyFrom *copySpec // a Secret whose data comes from the control plane
	ready    func(observed Object) bool
}

type copySpec struct {
	from           string // Secret name on the control plane
	field, toField string // "" copies data and type
}

func reported(o Object) bool { return len(live(o)) > 0 }

func objectReady(o Object) bool { return conditionTrue(o, "Ready") }

// live is the manifest as the location reports it.
func live(o Object) Object {
	m, _ := dig(o, "status", "atProvider", "manifest").(Object)
	return m
}

// liveReady: the condition t of the object in the location is true.
func liveReady(o Object, t string) bool { return conditionTrue(live(o), t) }

// siteObjects are what runs in a site's location, by composition resource
// name (without the site prefix).
func (c *composition) siteObjects(replicas int) (map[string]object, error) {
	spec := c.spec
	out := map[string]object{}
	out["envoyproxy"] = object{ready: reported, manifest: Object{
		"apiVersion": "gateway.envoyproxy.io/v1alpha1", "kind": "EnvoyProxy", "metadata": c.meta(c.name),
		"spec": Object{"provider": Object{"type": "Kubernetes", "kubernetes": Object{
			// Internal: clients in the location only, at a predictable name.
			"envoyService":    Object{"name": c.name, "type": "ClusterIP"},
			"envoyDeployment": Object{"replicas": replicas},
		}}},
	}}
	programmed := func(o Object) bool { return liveReady(o, "Programmed") }
	out["gateway"] = object{ready: programmed, manifest: Object{
		"apiVersion": "gateway.networking.k8s.io/v1", "kind": "Gateway", "metadata": c.meta(c.name),
		"spec": Object{
			"gatewayClassName": GatewayClass,
			"listeners":        []any{Object{"name": "http", "protocol": "HTTP", "port": 80}},
			"infrastructure": Object{"parametersRef": Object{
				"group": "gateway.envoyproxy.io", "kind": "EnvoyProxy", "name": c.name}},
		},
	}}
	gatewayRefs := []any{Object{"group": "gateway.networking.k8s.io", "kind": "Gateway", "name": c.name}}
	if e := spec.Expose; spec.exposed() {
		// A Gateway of its own: the LoadBalancer carries the HTTPS listener
		// only, never the internal plain HTTP one.
		external := c.name + "-external"
		svc := Object{"name": external, "type": "LoadBalancer", "loadBalancerSourceRanges": e.LoadBalancerSourceRanges}
		if len(e.Annotations) > 0 {
			svc["annotations"] = e.Annotations
		}
		out["external-envoyproxy"] = object{ready: reported, manifest: Object{
			"apiVersion": "gateway.envoyproxy.io/v1alpha1", "kind": "EnvoyProxy", "metadata": c.meta(external),
			"spec": Object{"provider": Object{"type": "Kubernetes", "kubernetes": Object{
				"envoyService":    svc,
				"envoyDeployment": Object{"replicas": replicas},
			}}},
		}}
		out["certificate"] = object{ready: func(o Object) bool { return liveReady(o, "Ready") }, manifest: Object{
			"apiVersion": "cert-manager.io/v1", "kind": "Certificate", "metadata": c.meta(c.name + "-tls"),
			"spec": Object{
				"secretName": c.name + "-tls",
				"dnsNames":   []any{e.Hostname},
				"issuerRef":  Object{"group": "cert-manager.io", "kind": "ClusterIssuer", "name": e.issuer()},
			},
		}}
		out["external-gateway"] = object{ready: programmed, manifest: Object{
			"apiVersion": "gateway.networking.k8s.io/v1", "kind": "Gateway", "metadata": c.meta(external),
			"spec": Object{
				"gatewayClassName": GatewayClass,
				"listeners": []any{Object{"name": "https", "protocol": "HTTPS", "port": 443, "hostname": e.Hostname,
					"tls": Object{"mode": "Terminate", "certificateRefs": []any{Object{"kind": "Secret", "name": c.name + "-tls"}}}}},
				"infrastructure": Object{"parametersRef": Object{
					"group": "gateway.envoyproxy.io", "kind": "EnvoyProxy", "name": external}},
			},
		}}
		gatewayRefs = append(gatewayRefs, Object{"group": "gateway.networking.k8s.io", "kind": "Gateway", "name": external})
	}
	out["clienttraffic"] = object{ready: reported, manifest: Object{
		"apiVersion": "gateway.envoyproxy.io/v1alpha1", "kind": "ClientTrafficPolicy", "metadata": c.meta(c.name),
		// Prompts with context, and images, can be large. Over HTTP/2 (the
		// exposed Gateway's HTTPS) a request is also limited to the stream's
		// flow-control window, 64Ki by default: one photo is more, a 413.
		"spec": Object{"targetRefs": gatewayRefs, "connection": Object{"bufferLimit": "50Mi"},
			"http2": Object{"initialStreamWindowSize": "50Mi", "initialConnectionWindowSize": "50Mi"}},
	}}
	out["backendtraffic"] = object{ready: reported, manifest: Object{
		"apiVersion": "gateway.envoyproxy.io/v1alpha1", "kind": "BackendTrafficPolicy", "metadata": c.meta(c.name),
		// Agent Router's per-backend filter buffers whole responses on the
		// upstream connection, 32Ki by default: an embedding (4096 floats as
		// JSON) or a long completion is more, and fails with a 500.
		"spec": Object{"targetRefs": gatewayRefs, "connection": Object{"bufferLimit": "50Mi"}},
	}}
	out["keys"] = object{ready: objectReady, copyFrom: &copySpec{from: KeysSecret(c.name)},
		manifest: Object{"apiVersion": "v1", "kind": "Secret", "metadata": c.meta(KeysSecret(c.name))}}
	out["securitypolicy"] = object{ready: reported, manifest: Object{
		"apiVersion": "gateway.envoyproxy.io/v1alpha1", "kind": "SecurityPolicy", "metadata": c.meta(c.name),
		"spec": Object{
			"targetRefs": gatewayRefs,
			// OpenAI clients send Authorization: Bearer <key>; it isn't forwarded.
			"apiKeyAuth": Object{
				"credentialRefs": []any{Object{"name": KeysSecret(c.name)}},
				"extractFrom":    []any{Object{"headers": []any{"Authorization"}}},
				"sanitize":       true,
			},
		},
	}}

	var rules []any
	models := append([]Model(nil), spec.Models...)
	sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
	for _, m := range models {
		id := "model-" + sha1hex(m.Name)[:8]
		obj := c.name + "-" + id
		u, err := url.Parse(m.Endpoint)
		if err != nil || u.Hostname() == "" {
			return nil, fmt.Errorf("model %q: endpoint %q is not a URL", m.Name, m.Endpoint)
		}
		tls := u.Scheme == "https"
		port := 80
		if tls {
			port = 443
		}
		if p := u.Port(); p != "" {
			port, _ = strconv.Atoi(p)
		}
		out[id+"-backend"] = object{ready: reported, manifest: Object{
			"apiVersion": "gateway.envoyproxy.io/v1alpha1", "kind": "Backend", "metadata": c.meta(obj),
			"spec": Object{"endpoints": []any{Object{"fqdn": Object{"hostname": u.Hostname(), "port": port}}}},
		}}
		schema := Object{"name": m.schema()}
		if p := strings.TrimSuffix(u.Path, "/"); p != "" {
			schema["prefix"] = p
		}
		out[id+"-aiservicebackend"] = object{ready: reported, manifest: Object{
			"apiVersion": "aigateway.envoyproxy.io/v1beta1", "kind": "AIServiceBackend", "metadata": c.meta(obj),
			"spec": Object{"schema": schema, "backendRef": Object{"group": "gateway.envoyproxy.io", "kind": "Backend", "name": obj}},
		}}
		if tls {
			out[id+"-tls"] = object{ready: reported, manifest: Object{
				"apiVersion": "gateway.networking.k8s.io/v1", "kind": "BackendTLSPolicy", "metadata": c.meta(obj),
				"spec": Object{
					"targetRefs": []any{Object{"group": "gateway.envoyproxy.io", "kind": "Backend", "name": obj}},
					"validation": Object{"wellKnownCACertificates": "System", "hostname": u.Hostname()},
				},
			}}
		}
		if ref := m.APIKeySecretRef; ref != nil {
			// The provider's key under "apiKey", as Agent Router reads it.
			out[id+"-apikey"] = object{ready: objectReady,
				copyFrom: &copySpec{from: ref.Name, field: "data." + or(ref.Key, "apiKey"), toField: "data.apiKey"},
				manifest: Object{"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": c.meta(obj + "-apikey")}}
			policy := Object{"targetRefs": []any{Object{"group": "aigateway.envoyproxy.io", "kind": "AIServiceBackend", "name": obj}}}
			if m.schema() == "Anthropic" {
				policy["type"], policy["anthropicAPIKey"] = "AnthropicAPIKey", Object{"secretRef": Object{"name": obj + "-apikey"}}
			} else {
				policy["type"], policy["apiKey"] = "APIKey", Object{"secretRef": Object{"name": obj + "-apikey"}}
			}
			out[id+"-backendsecurity"] = object{ready: reported, manifest: Object{
				"apiVersion": "aigateway.envoyproxy.io/v1beta1", "kind": "BackendSecurityPolicy", "metadata": c.meta(obj),
				"spec": policy,
			}}
		}
		backendRef := Object{"name": obj}
		if m.UpstreamModel != "" {
			backendRef["modelNameOverride"] = m.UpstreamModel
		}
		rules = append(rules, Object{
			"matches":     []any{Object{"headers": []any{Object{"type": "Exact", "name": "x-ai-eg-model", "value": m.Name}}}},
			"backendRefs": []any{backendRef},
		})
	}
	if len(rules) > 0 {
		out["route"] = object{ready: reported, manifest: Object{
			"apiVersion": "aigateway.envoyproxy.io/v1beta1", "kind": "AIGatewayRoute", "metadata": c.meta(c.name),
			"spec": Object{"parentRefs": gatewayRefs, "rules": rules},
		}}
	}
	return out, nil
}

// wrap puts a location object into a provider-kubernetes Object.
func (c *composition) wrap(key, location string, manifest Object, copyFrom *copySpec) Composed {
	spec := Object{
		"providerConfigRef": Object{"kind": "ClusterProviderConfig", "name": location},
		"watch":             true,
		"forProvider":       Object{"manifest": manifest},
	}
	if cp := copyFrom; cp != nil {
		// The Secret's data comes from the control plane, never through this spec.
		var refs []any
		if cp.field == "" {
			for _, f := range []string{"data", "type"} {
				refs = append(refs, Object{"patchesFrom": Object{"apiVersion": "v1", "kind": "Secret",
					"name": cp.from, "namespace": c.ns, "fieldPath": f}})
			}
		} else {
			refs = append(refs, Object{"patchesFrom": Object{"apiVersion": "v1", "kind": "Secret",
				"name": cp.from, "namespace": c.ns, "fieldPath": cp.field}, "toFieldPath": cp.toField})
		}
		spec["references"] = refs
	}
	return Composed{Object: Object{
		"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
		"metadata": Object{"name": c.name + "-" + key, "namespace": c.ns, "labels": c.labels,
			"annotations": map[string]string{"platform.cndev.nl/location": location}},
		"spec": spec,
	}}
}

// keep returns a generated value, read back from the observed composed
// Secret once it exists.
func (c *composition) keep(key, field string) string {
	if enc, _ := dig(c.observed[key], "data", field).(string); enc != "" {
		if raw, err := base64.StdEncoding.DecodeString(enc); err == nil && len(raw) > 0 {
			return string(raw)
		}
	}
	return NewKey()
}

func (c *composition) meta(name string) Object {
	labels := map[string]string{}
	for k, v := range c.labels {
		labels[k] = v
	}
	return Object{"name": name, "namespace": c.ns, "labels": labels}
}

// --- helpers

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func dig(obj any, path ...string) any {
	for _, p := range path {
		m, ok := obj.(map[string]any)
		if !ok {
			return nil
		}
		if obj, ok = m[p]; !ok {
			return nil
		}
	}
	return obj
}

func decode(v any, into any) {
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = json.Unmarshal(raw, into) //nolint:errcheck // best effort
}

func conditionTrue(obj Object, t string) bool {
	conds, _ := dig(obj, "status", "conditions").([]any)
	for _, c := range conds {
		if m, ok := c.(map[string]any); ok && m["type"] == t && m["status"] == "True" {
			return true
		}
	}
	return false
}

func sha1hex(s string) string {
	sum := sha1.Sum([]byte(s)) //nolint:gosec // see import
	return hex.EncodeToString(sum[:])
}
