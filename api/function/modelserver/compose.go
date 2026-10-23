// Package modelserver composes a ModelServer (ai.cndev.nl/v1alpha1): a
// self-hosted model, vLLM on KServe, with llm-d's inference scheduler for
// prefix-cache-aware routing, in its Project's protected site and
// optionally its recovery site.
//
// In each site's location (provider-kubernetes Objects, prefix "<site>-"):
//
//	server           LLMInferenceService <name> (serving.kserve.io/v1alpha2):
//	                 vLLM serving spec.model.uri as the served name, the
//	                 site's replicas, GPUs (tensor parallel over more than
//	                 one); with spec.routing.prefixCacheAware (default) KServe
//	                 adds llm-d's endpoint picker and InferencePool
//	                 <name>-inference-pool, which a ModelGateway routes to
//	token,           with spec.model.tokenSecretRef: Secret <name>-model-token
//	serviceaccount   (HF_TOKEN patched from the Project's Secret, never in the
//	                 Object spec) and ServiceAccount <name>-model listing it,
//	                 from which KServe hands the token to the model download
//	podmonitor       vLLM's metrics (requests, queue, KV and prefix cache,
//	                 latency, tokens), labelled with server
//	prometheusrule   with replicas in the site: no ready replica, requests
//	                 waiting, KV cache full, slow first token (spec.alerts)
//
// On the control plane: dashboard, a GrafanaDashboard in the Project's
// Grafana (monitoring.go).
//
// KServe names what it creates after the LLMInferenceService: the Service
// <name>-kserve-workload-svc:8000 (plain HTTP, the platform leaves KServe's
// TLS between gateway and server off) and the InferencePool. Locations are
// pinned in status.sites, so a server never moves.
package modelserver

import (
	"crypto/sha1" //nolint:gosec // names, not a security boundary
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// RequiredProject is the Project the server's sites come from.
const RequiredProject = "project"

// Port is vLLM's, behind KServe's workload Service.
const Port = 8000

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
	Replicas int    `json:"replicas"`
	Ready    bool   `json:"ready"`
	Message  string `json:"message,omitempty"`
}

type Status struct {
	Ready         bool         `json:"ready"`
	Message       string       `json:"message"`
	Model         string       `json:"model"`
	Endpoint      string       `json:"endpoint"`
	InferencePool string       `json:"inferencePool,omitempty"`
	DashboardUID  string       `json:"dashboardUid,omitempty"`
	Sites         []SiteStatus `json:"sites"`
}

type Output struct {
	Composed  map[string]Composed
	Status    Status
	Condition Condition
}

// InferencePool is the pool KServe creates for server name: what a gateway
// routes to with prefix-cache-aware routing.
func InferencePool(name string) string { return name + "-inference-pool" }

// Service is KServe's Service in front of server name's replicas.
func Service(name string) string { return name + "-kserve-workload-svc" }

// Endpoint is the OpenAI base URL of server name in namespace, in each of its sites.
func Endpoint(name, namespace string) string {
	return fmt.Sprintf("http://%s.%s.svc:%d/v1", Service(name), namespace, Port)
}

// ServedName is the model name the server answers to: spec.model.name, else its name.
func ServedName(xr Object) string {
	var s XR
	decode(xr, &s)
	return or(s.Spec.Model.Name, s.Metadata.Name)
}

type composition struct {
	spec     *Spec
	name, ns string
	observed map[string]Object
	labels   map[string]string
}

// Compose renders the desired state of a ModelServer.
func Compose(in Input) (*Output, error) {
	var xr XR
	decode(in.XR, &xr)
	c := &composition{spec: &xr.Spec, name: xr.Metadata.Name, ns: xr.Metadata.Namespace, observed: in.Observed}
	c.labels = map[string]string{
		"app.kubernetes.io/managed-by": "crossplane",
		"app.kubernetes.io/part-of":    "basis",
		"ai.cndev.nl/modelserver":      c.name,
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
	sites := []string{SiteProtected}
	if spec.Recovery.Enabled {
		sites = append(sites, SiteRecovery)
	}

	dashboard := c.dashboard()
	out.Composed["dashboard"] = Composed{Ready: true, Object: dashboard}
	status := Status{Model: or(spec.Model.Name, c.name), Endpoint: Endpoint(c.name, c.ns), Sites: []SiteStatus{},
		DashboardUID: dig(dashboard, "spec", "uid").(string)}
	if spec.prefixCacheAware() {
		status.InferencePool = InferencePool(c.name)
	}

	var problems, waiting []string
	allReady, serving := true, false
	for _, s := range sites {
		replicas := spec.siteReplicas(s)
		loc := location(s)
		ss := SiteStatus{Site: s, Location: loc, Replicas: replicas}
		if loc == "" {
			status.Sites = append(status.Sites, ss)
			problems = append(problems, fmt.Sprintf("Project %s has no %s location (spec.locations.%s)", c.ns, s, s))
			allReady = false
			continue
		}
		for key, o := range c.siteObjects(s, replicas) {
			k := s + "-" + key
			w := c.wrap(k, loc, o.manifest, o.copyFrom)
			w.Ready = o.ready(c.observed[k])
			out.Composed[k] = w
		}
		server := c.observed[s+"-server"]
		ss.Ready = out.Composed[s+"-server"].Ready
		if synced := condition(server, "Synced"); synced != nil && synced["status"] == "False" {
			msg, _ := synced["message"].(string)
			ss.Message = fmt.Sprintf("can't apply the LLMInferenceService in %s (is KServe installed there?): %s", loc, msg)
			problems = append(problems, ss.Message)
		} else if !ss.Ready {
			ss.Message = or(notReady(live(server)), fmt.Sprintf("waiting for KServe in %s", loc))
			waiting = append(waiting, fmt.Sprintf("%s (%s): %s", s, loc, ss.Message))
		}
		if t, ok := out.Composed[s+"-token"]; ok && !t.Ready {
			ss.Ready = false
			waiting = append(waiting, fmt.Sprintf("%s: copying the token Secret %s to %s", s, spec.Model.TokenSecretRef.Name, loc))
		}
		allReady = allReady && ss.Ready
		serving = serving || (ss.Ready && replicas > 0)
		status.Sites = append(status.Sites, ss)
	}

	status.Ready = allReady
	cond := Condition{Status: allReady, Reason: "Available"}
	switch {
	case len(problems) > 0:
		status.Message = strings.Join(problems, "; ")
		cond.Reason = "Waiting"
	case !allReady:
		status.Message = "Waiting for vLLM: " + strings.Join(waiting, "; ")
		cond.Reason = "Creating"
	case !serving:
		status.Message = fmt.Sprintf("Server %s is stopped (no replicas)", c.name)
	default:
		status.Message = fmt.Sprintf("Server %s serves %s", c.name, status.Model)
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
	field, toField string
}

func reported(o Object) bool { return len(live(o)) > 0 }

// always: serving doesn't wait for it (metrics, alerts).
func always(Object) bool { return true }

func objectReady(o Object) bool { return conditionTrue(o, "Ready") }

// live is the manifest as the location reports it.
func live(o Object) Object {
	m, _ := dig(o, "status", "atProvider", "manifest").(Object)
	return m
}

// tokenSecret and serviceAccount carry the Hugging Face token in the location.
func (c *composition) tokenSecret() string    { return c.name + "-model-token" }
func (c *composition) serviceAccount() string { return c.name + "-model" }

// siteObjects are what runs in a site's location, by composition resource
// name (without the site prefix).
func (c *composition) siteObjects(site string, replicas int) map[string]object {
	spec := c.spec
	out := map[string]object{}
	res := spec.Resources
	requests := Object{"cpu": res.cpu(), "memory": res.memory()}
	limits := Object{"memory": res.memory()}
	if g := res.gpus(); g > 0 {
		requests[res.gpuResource()], limits[res.gpuResource()] = g, g
	}
	main := Object{"name": "main", "resources": Object{"requests": requests, "limits": limits}}
	if spec.Image != "" {
		main["image"] = spec.Image
	}
	if res.gpus() == 0 {
		// vLLM's CPU image runs as root; KServe's own CPU sample allows it
		// the same way. Privilege escalation and capabilities stay off.
		main["securityContext"] = Object{"runAsNonRoot": false}
	}
	if len(spec.Args) > 0 {
		// After KServe's own flags (its command ends in "$@").
		args := make([]any, len(spec.Args))
		for i, a := range spec.Args {
			args[i] = a
		}
		main["args"] = args
	}
	template := Object{"containers": []any{main}}
	if len(spec.Scheduling.NodeSelector) > 0 {
		template["nodeSelector"] = spec.Scheduling.NodeSelector
	}
	if len(spec.Scheduling.Tolerations) > 0 {
		template["tolerations"] = spec.Scheduling.Tolerations
	}
	if ref := spec.Model.TokenSecretRef; ref != nil {
		// KServe gives the model download the HF_TOKEN of the Secrets its
		// ServiceAccount lists.
		template["serviceAccountName"] = c.serviceAccount()
		out["token"] = object{ready: objectReady,
			copyFrom: &copySpec{from: ref.Name, field: "data." + or(ref.Key, "HF_TOKEN"), toField: "data.HF_TOKEN"},
			manifest: Object{"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": c.meta(c.tokenSecret())}}
		out["serviceaccount"] = object{ready: reported, manifest: Object{
			"apiVersion": "v1", "kind": "ServiceAccount", "metadata": c.meta(c.serviceAccount()),
			"secrets": []any{Object{"name": c.tokenSecret()}},
		}}
	}
	server := Object{
		"model":    Object{"uri": spec.Model.URI, "name": or(spec.Model.Name, c.name)},
		"replicas": replicas,
		"template": template,
		// Onto everything KServe creates, next to its own labels. Not the
		// app.kubernetes.io ones: KServe's part-of label is how it finds its
		// Deployments, and how the InferencePool and PodMonitor select pods.
		"labels": map[string]string{"ai.cndev.nl/modelserver": c.name},
	}
	if g := res.gpus(); g > 1 {
		server["parallelism"] = Object{"tensor": g}
	}
	if spec.prefixCacheAware() {
		// llm-d's endpoint picker with KServe's default configuration:
		// approximate prefix-cache affinity, then the replicas' token load.
		server["router"] = Object{"scheduler": Object{}}
	}
	out["server"] = object{ready: func(o Object) bool {
		// A stopped site has nothing to wait for.
		return conditionTrue(live(o), "Ready") || (replicas == 0 && reported(o))
	}, manifest: Object{
		"apiVersion": "serving.kserve.io/v1alpha2", "kind": "LLMInferenceService", "metadata": c.meta(c.name),
		"spec": server,
	}}
	out["podmonitor"] = object{ready: always, manifest: c.podMonitor()}
	if !spec.Alerts.Disabled && replicas > 0 {
		out["prometheusrule"] = object{ready: always, manifest: c.alertRules()}
	}
	return out
}

// notReady is the message of the first condition KServe reports as not true.
func notReady(o Object) string {
	conds, _ := dig(o, "status", "conditions").([]any)
	var msgs []string
	for _, cd := range conds {
		m, _ := cd.(map[string]any)
		if m["status"] != "True" && m["type"] != "Ready" {
			if msg, _ := m["message"].(string); msg != "" {
				msgs = append(msgs, fmt.Sprintf("%v: %s", m["type"], msg))
			}
		}
	}
	sort.Strings(msgs)
	if len(msgs) > 0 {
		return msgs[0]
	}
	return ""
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
		spec["references"] = []any{Object{"patchesFrom": Object{"apiVersion": "v1", "kind": "Secret",
			"name": cp.from, "namespace": c.ns, "fieldPath": cp.field}, "toFieldPath": cp.toField}}
	}
	return Composed{Object: Object{
		"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
		"metadata": Object{"name": c.name + "-" + key, "namespace": c.ns, "labels": c.labels,
			"annotations": map[string]string{"platform.cndev.nl/location": location}},
		"spec": spec,
	}}
}

func (c *composition) meta(name string) Object {
	labels := map[string]string{}
	for k, v := range c.labels {
		labels[k] = v
	}
	return Object{"name": name, "namespace": c.ns, "labels": labels}
}

// --- helpers

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

func condition(obj Object, t string) map[string]any {
	conds, _ := dig(obj, "status", "conditions").([]any)
	for _, c := range conds {
		if m, ok := c.(map[string]any); ok && m["type"] == t {
			return m
		}
	}
	return nil
}

func conditionTrue(obj Object, t string) bool {
	c := condition(obj, t)
	return c != nil && c["status"] == "True"
}

func sha1hex(s string) string {
	sum := sha1.Sum([]byte(s)) //nolint:gosec // see import
	return hex.EncodeToString(sum[:])
}
