// Package valkeycache composes a ValkeyCache (cache.cndev.nl/v1alpha1).
//
// The namespaced XR lives in its Project's namespace on the control plane,
// which runs no caches. Like PostgresCluster, what runs goes to the Project's
// protected location, each object wrapped in a provider-kubernetes Object for
// the ClusterProviderConfig named after the location; the password Secret and
// the GrafanaDashboard (the project's Grafana runs on the control plane) are
// composed directly:
//
//	auth-secret     Secret <name>-valkey: username, password (generated once,
//	                then kept), host, port, uri. What tenants and the portal read.
//	auth            Secret <name>-valkey-auth in the location, data and type
//	                patched from auth-secret (never in the Object spec)
//	cluster         ValkeyCluster <name> (valkey-io operator): cluster mode, no
//	                persistence, maxmemory + eviction policy, the default user
//	                with the password; semantic mode adds the valkey-bundle
//	                image with valkey-search and the exporter's module metrics
//	podmonitor      PodMonitor <name>-valkey for the redis_exporter sidecar,
//	                labelling every series with cluster, shard and node
//	prometheusrule  PrometheusRule <name>-alerts: the cache alerts
//	                (src/alerts/valkey-cache-rules.yaml) scoped to this cache
//	dashboard       GrafanaDashboard <name>-valkey: src/dashboards/valkey-cache.json
//	                with its own title and uid, preselected on this cache
//
// Location: the Project's location for spec.site, protected (default) or
// recovery (Project spec.locations.<site>, a required resource named after the
// namespace), pinned in status.location on first use, so a cache never moves
// and a missing Project never empties the composition.
package valkeycache

import (
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // a dashboard uid, not a security boundary
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

// Images, pinned; bump them together with the operator in ../../../deps/README.md.
const (
	Image        = "valkey/valkey:9.1.2"
	BundleImage  = "valkey/valkey-bundle:9.1.2"
	SearchModule = "/usr/lib/valkey/libsearch.so"
	Port         = 6379
)

// RequiredProject is the requirement name of the Project the composition reads.
const RequiredProject = "project"

// Object is a Kubernetes object as unstructured JSON.
type Object = map[string]any

// Requirement is a resource the composition needs to see.
type Requirement struct {
	APIVersion, Kind, Name string
}

// Requirements returns what Compose reads besides the XR: the Project named
// after the XR's namespace.
func Requirements(namespace string) map[string]Requirement {
	return map[string]Requirement{RequiredProject: {"platform.cndev.nl/v1alpha1", "Project", namespace}}
}

// Input is one reconcile's view.
type Input struct {
	XR       Object
	Observed map[string]Object
	// Required resources, by requirement name; present once Crossplane resolved it.
	Required map[string][]Object
}

// Composed is a desired composed resource.
type Composed struct {
	Object Object
	Ready  bool
}

// Condition is the CacheReady condition on the XR.
type Condition struct {
	Status  bool
	Reason  string
	Message string
}

// Status is the XR's status (definition.yaml).
type Status struct {
	Ready       bool              `json:"ready"`
	State       string            `json:"state"`
	Message     string            `json:"message"`
	Shards      int               `json:"shards"`
	ReadyShards int               `json:"readyShards"`
	Site        string            `json:"site"`
	Location    string            `json:"location,omitempty"`
	Endpoint    string            `json:"endpoint"`
	Secret      string            `json:"secret"`
	Modules     []string          `json:"modules"`
	Monitoring  *MonitoringStatus `json:"monitoring,omitempty"`
}

type MonitoringStatus struct {
	DashboardUID string `json:"dashboardUid"`
}

// Output is the desired state.
type Output struct {
	Composed  map[string]Composed
	Status    Status
	Condition Condition
}

// NewPassword generates the default user's password; tests replace it.
var NewPassword = func() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, 32)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			panic(fmt.Sprintf("crypto/rand: %v", err)) // the OS has no entropy source
		}
		b[i] = alphabet[n.Int64()]
	}
	return string(b)
}

type composition struct {
	xr       XR
	spec     *Spec
	name, ns string
	observed map[string]Object
	labels   map[string]string
}

// Compose renders the desired state of a ValkeyCache.
func Compose(in Input) (*Output, error) {
	c := &composition{observed: in.Observed}
	decode(in.XR, &c.xr)
	c.spec = &c.xr.Spec
	c.name, c.ns = c.xr.Metadata.Name, c.xr.Metadata.Namespace
	c.labels = map[string]string{
		"app.kubernetes.io/managed-by": "crossplane",
		"app.kubernetes.io/part-of":    "basis",
		"cache.cndev.nl/valkeycache":   c.name,
	}

	// ---- location: pinned in status.location, else the Project's protected location
	var project Object
	if projects := in.Required[RequiredProject]; len(projects) > 0 {
		project = projects[0]
	}
	site := c.spec.site()
	projectLocation, _ := dig(project, "spec", "locations", site).(string)
	location := or(c.xr.Status.Location, projectLocation)
	if _, resolved := in.Required[RequiredProject]; location == "" && resolved && c.running() {
		return nil, fmt.Errorf("ValkeyCache %s/%s has composed resources but no location: neither status.location nor Project %s says where it runs", c.ns, c.name, c.ns)
	}

	spec, mon := c.spec, &c.spec.Monitoring
	out := &Output{Composed: map[string]Composed{}}
	secretName, copyName := c.name+"-valkey", c.name+"-valkey-auth"
	host := fmt.Sprintf("valkey-%s.%s.svc", c.name, c.ns)

	// ---- the password: generated once, then read back from the observed Secret
	password := ""
	if enc, _ := dig(c.observed["auth-secret"], "data", "password").(string); enc != "" {
		if raw, err := base64.StdEncoding.DecodeString(enc); err == nil {
			password = string(raw)
		}
	}
	if password == "" {
		password = NewPassword()
	}
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	out.Composed["auth-secret"] = Composed{Ready: c.observed["auth-secret"] != nil, Object: Object{
		"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
		"metadata": c.meta(secretName, nil),
		"data": map[string]string{
			"username": b64("default"), "password": b64(password), "host": b64(host),
			"port": b64(strconv.Itoa(Port)), "uri": b64(fmt.Sprintf("valkey://default:%s@%s:%d", password, host, Port)),
		},
	}}

	dashUID := "valkey-" + sha1hex(c.ns + "/" + c.name)[:20]
	if mon.dashboard() {
		out.Composed["dashboard"] = Composed{Object: c.dashboard(dashUID), Ready: c.observed["dashboard"] != nil}
	}

	modules := []string{}
	if spec.semantic() {
		modules = []string{"search"}
	}
	status := Status{Site: site, State: "Pending", Endpoint: fmt.Sprintf("%s:%d", host, Port), Secret: secretName, Modules: modules}
	if mon.dashboard() {
		status.Monitoring = &MonitoringStatus{DashboardUID: dashUID}
	}
	if location == "" {
		status.Message = fmt.Sprintf("Namespace %s is not a Project with a %s location (Project spec.locations.%s)", c.ns, site, site)
		out.Status, out.Condition = status, Condition{Reason: "NoLocation", Message: status.Message}
		return out, nil
	}
	status.Location = location

	// ---- what the location reports
	copyReady := conditionTrue(c.observed["auth"], "Ready")
	var vcStatus struct {
		State       string `json:"state"`
		Message     string `json:"message"`
		Shards      int    `json:"shards"`
		ReadyShards int    `json:"readyShards"`
	}
	decode(dig(c.observed["cluster"], "status", "atProvider", "manifest", "status"), &vcStatus)
	clusterReady := vcStatus.State == "Ready"
	synced := condition(c.observed["cluster"], "Synced")
	reported := func(key string) bool {
		m, _ := dig(c.observed[key], "status", "atProvider", "manifest").(Object)
		return len(m) > 0
	}
	ready := map[string]bool{"auth": copyReady, "cluster": clusterReady,
		"podmonitor": reported("podmonitor"), "prometheusrule": reported("prometheusrule")}

	objects, err := c.locationObjects(copyName)
	if err != nil {
		return nil, err
	}
	for key, obj := range objects {
		w := c.wrap(key, location, obj)
		w.Ready = ready[key]
		out.Composed[key] = w
	}

	status.Ready = copyReady && clusterReady
	status.State = or(vcStatus.State, "Pending")
	status.Shards, status.ReadyShards = vcStatus.Shards, vcStatus.ReadyShards
	cond := Condition{Status: status.Ready, Reason: "Available"}
	switch {
	case synced != nil && synced["status"] == "False":
		msg, _ := synced["message"].(string)
		status.Message = fmt.Sprintf("Can't apply the ValkeyCluster in location %s (is the Valkey operator installed there?): %s", location, msg)
		cond.Reason = "ApplyFailed"
	case !clusterReady:
		status.Message = or(vcStatus.Message, fmt.Sprintf("Waiting for the ValkeyCluster in location %s", location))
		cond.Reason = "Creating"
	case !copyReady:
		status.Message = fmt.Sprintf("Copying the password Secret to location %s", location)
		cond.Reason = "Creating"
	default:
		status.Message = fmt.Sprintf("Cache %s is ready", c.name)
	}
	cond.Message = status.Message
	out.Status, out.Condition = status, cond
	return out, nil
}

// running reports whether the XR already composes more than what lives on
// the control plane, i.e. there may be a cache to protect.
func (c *composition) running() bool {
	for key := range c.observed {
		if key != "auth-secret" && key != "dashboard" {
			return true
		}
	}
	return false
}

// locationObjects are the manifests for the location, by composition resource name.
func (c *composition) locationObjects(copyName string) (map[string]Object, error) {
	spec, mon := c.spec, &c.spec.Monitoring
	out := map[string]Object{
		// The copy's data and type come from auth-secret (see wrap).
		"auth": {"apiVersion": "v1", "kind": "Secret", "metadata": c.meta(copyName, nil)},
	}

	vcSpec := Object{
		"image":     Image,
		"shards":    spec.shards(),
		"replicas":  spec.replicas(),
		"resources": Object{"requests": Object{"cpu": spec.cpu(), "memory": spec.memory()}, "limits": Object{"memory": spec.memory()}},
		"config":    Object{"maxmemory": maxMemory(spec.memory(), spec.maxMemoryPct()), "maxmemory-policy": spec.evictionPolicy()},
		"users": []any{Object{
			"name":           "default",
			"passwordSecret": Object{"name": copyName, "keys": []any{"password"}},
			"commands":       Object{"allow": []any{"@all"}, "deny": []any{"@admin"}},
			"keys":           Object{"readWrite": []any{"*"}},
			"channels":       Object{"patterns": []any{"*"}},
		}},
		"scheduling": Object{"node": Object{"spread": Object{"shard": Object{"mode": "Preferred"}}}},
		"exporter":   Object{"enabled": mon.enabled()},
	}
	if spec.semantic() {
		threads := searchThreads(spec.cpu())
		vcSpec["image"] = BundleImage
		// Appended to the server's valkey-server command (strategic merge patch by name).
		vcSpec["containers"] = []any{Object{"name": "server", "args": []any{
			"--loadmodule", fmt.Sprintf("%s --reader-threads %d --writer-threads %d", SearchModule, threads, threads)}}}
		if mon.enabled() {
			// valkey-search's INFO section (index memory, query counts) for the dashboard.
			vcSpec["exporter"] = Object{"enabled": true, "args": []any{"--include-modules-metrics"}}
		}
	}
	out["cluster"] = Object{"apiVersion": "valkey.io/v1alpha1", "kind": "ValkeyCluster",
		"metadata": c.meta(c.name, nil), "spec": vcSpec}

	monLabels := map[string]string{}
	for k, v := range mon.PodMonitorLabels {
		monLabels[k] = v
	}
	if mon.enabled() {
		relabel := func(label, target string) Object {
			return Object{"sourceLabels": []any{"__meta_kubernetes_pod_label_" + label}, "targetLabel": target}
		}
		out["podmonitor"] = Object{"apiVersion": "monitoring.coreos.com/v1", "kind": "PodMonitor",
			"metadata": c.meta(c.name+"-valkey", monLabels),
			"spec": Object{
				"selector": Object{"matchLabels": Object{"valkey.io/cluster": c.name}},
				"podMetricsEndpoints": []any{Object{"port": "metrics", "relabelings": []any{
					relabel("valkey_io_cluster", "cluster"),
					relabel("valkey_io_shard_index", "shard"),
					relabel("valkey_io_node_index", "node"),
				}}},
			}}
	}
	if mon.rules() {
		rules, err := alertRules(c.ns, c.name, mon.PrometheusRule.ExcludeRules)
		if err != nil {
			return nil, err
		}
		out["prometheusrule"] = Object{"apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule",
			"metadata": c.meta(c.name+"-alerts", monLabels),
			"spec":     Object{"groups": []any{Object{"name": fmt.Sprintf("valkey/%s/%s", c.ns, c.name), "rules": rules}}}}
	}
	return out, nil
}

// wrap puts a location object into a provider-kubernetes Object.
func (c *composition) wrap(key, location string, manifest Object) Composed {
	spec := Object{
		"providerConfigRef": Object{"kind": "ClusterProviderConfig", "name": location},
		"watch":             true,
		"forProvider":       Object{"manifest": manifest},
	}
	if key == "auth" {
		// The Secret's data comes from the control plane, never through this spec.
		var refs []any
		for _, field := range []string{"data", "type"} {
			refs = append(refs, Object{"patchesFrom": Object{"apiVersion": "v1", "kind": "Secret",
				"name": c.name + "-valkey", "namespace": c.ns, "fieldPath": field}})
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

// dashboard is the Valkey cache dashboard for this cache: its own title and
// uid, the namespace/cluster variables preset.
func (c *composition) dashboard(uid string) Object {
	g := c.spec.Monitoring.GrafanaDashboard
	selector := g.InstanceSelector
	if len(selector) == 0 {
		selector = map[string]string{"dashboards.paas.cndev.nl/scope": c.ns}
	}
	return Object{
		"apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDashboard",
		"metadata": c.meta(c.name+"-valkey", nil),
		"spec": Object{
			"instanceSelector":          Object{"matchLabels": selector},
			"allowCrossNamespaceImport": g.AllowCrossNamespaceImport,
			"folder":                    or(g.Folder, "Valkey"),
			"uid":                       uid,
			"resyncPeriod":              "10m",
			"datasources":               []any{Object{"inputName": "DS_PROMETHEUS", "datasourceName": or(g.DatasourceName, "prometheus")}},
			"json":                      dashboardJSON(c.ns, c.name, uid),
		},
	}
}

func (c *composition) meta(name string, extra map[string]string) Object {
	labels := map[string]string{}
	for k, v := range c.labels {
		labels[k] = v
	}
	for k, v := range extra {
		labels[k] = v
	}
	return Object{"name": name, "namespace": c.ns, "labels": labels}
}

// maxMemory is pct of the memory limit in mb (1024^2 bytes for Valkey).
func maxMemory(memory string, pct int) string {
	mi := 0
	switch {
	case strings.HasSuffix(memory, "Gi"):
		n, _ := strconv.Atoi(strings.TrimSuffix(memory, "Gi"))
		mi = n * 1024
	default:
		mi, _ = strconv.Atoi(strings.TrimSuffix(memory, "Mi"))
	}
	return fmt.Sprintf("%dmb", mi*pct/100)
}

// searchThreads caps valkey-search's thread pools at the pod's CPU (it sizes
// them to the node's cores otherwise).
func searchThreads(cpu string) int {
	var cores float64
	if strings.HasSuffix(cpu, "m") {
		m, _ := strconv.Atoi(strings.TrimSuffix(cpu, "m"))
		cores = float64(m) / 1000
	} else {
		cores, _ = strconv.ParseFloat(cpu, 64)
	}
	threads := int(cores)
	if float64(threads) < cores {
		threads++
	}
	return max(threads, 1)
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
	_ = json.Unmarshal(raw, into) //nolint:errcheck // best effort: unexpected fields are skipped
}

// condition returns the status condition of type t of an observed object.
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
