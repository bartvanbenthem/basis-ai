// Package mcpserver composes an MCPServer (ai.cndev.nl/v1alpha1): an MCP
// server with retrieval and agent memory over a Project's database
// (basis-mcp, ../../../mcp), in its protected site and optionally a standby
// in its recovery site.
//
// On the control plane, next to the XR:
//
//	keys             Secret <name>-keys: an API key per spec.clients entry,
//	                 generated once, then kept; a removed or expired
//	                 client's key goes
//	dashboard        a GrafanaDashboard in the Project's Grafana (monitoring.go)
//
// In each site's location (provider-kubernetes Objects, prefix "<site>-"):
//
//	keys             Secret <name>-keys, data from the control plane's;
//	                 mounted, re-read by the server without a restart
//	config           ConfigMap <name>-config: config.json, what the server
//	                 serves (tables, search mode, memory scope, the
//	                 clients and their tools)
//	deployment       Deployment <name>: basis-mcp, the site's replicas, the
//	                 database and embeddings endpoint from the environment
//	                 (below); restarted when its config changes
//	service          Service <name>:80, the endpoint http://<name>.<ns>.svc/mcp
//	pdb              with more than one replica: PodDisruptionBudget, one stays
//	podmonitor       the server's metrics (calls per tool and client,
//	                 latency, embeddings, database readiness)
//	prometheusrule   with replicas in the site: down, database not ready,
//	                 failing tool calls, slow calls (spec.alerts), failing
//	                 embeddings
//
// The database: with spec.database.stack the stack's Secret
// <stack>-connection in the location (DATABASE_URL, and OPENAI_BASE_URL and
// OPENAI_API_KEY of the stack's gateway for the embeddings). With
// spec.database.cluster its -rw Service, as the role of
// spec.database.credentialsSecretRef (copied there, "database") or the
// database owner (CloudNativePG's <cluster>-app); embeddings through
// spec.embeddings.gateway with the server's own key there ("embeddings",
// copied from the gateway's keys Secret).
//
// The active site, where the database's primary runs (the stack's
// status.activeSite, the cluster's status.primarySite), gets spec.replicas,
// the standby spec.recovery.replicas: it answers search, fetch and recall
// from the replica, and refuses writes until the primary moves there.
// Locations are pinned in status.sites, so a server never moves.
package mcpserver

import (
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // names, not a security boundary
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

// DefaultImage is basis-mcp's, built from ../../../mcp (mcp/Makefile's VERSION).
const DefaultImage = "ghcr.io/bartvanbenthem/basis-mcp:v0.1.0"

// Requirement names.
const (
	RequiredProject     = "project"
	RequiredDatabase    = "database"
	RequiredGatewayKeys = "gateway-keys"
)

// Ports of basis-mcp.
const (
	HTTPPort    = 8080
	MetricsPort = 9090
)

type Object = map[string]any

// Requirement is a resource the composition needs to see; Namespace empty
// for a cluster-scoped one.
type Requirement struct {
	APIVersion, Kind, Namespace, Name string
}

// Requirements: the Project (its sites), the database's XR (its active
// site), and with a cluster's embeddings the gateway's keys.
func Requirements(xr Object) map[string]Requirement {
	var x XR
	decode(xr, &x)
	ns := x.Metadata.Namespace
	reqs := map[string]Requirement{RequiredProject: {"platform.cndev.nl/v1alpha1", "Project", "", ns}}
	db := x.Spec.Database
	switch {
	case db.Stack != "":
		reqs[RequiredDatabase] = Requirement{"ai.cndev.nl/v1alpha1", "GenAIStack", ns, db.Stack}
	case db.Cluster != "":
		reqs[RequiredDatabase] = Requirement{"postgres.cndev.nl/v1alpha1", "PostgresCluster", ns, db.Cluster}
		if x.Spec.embeds() && x.Spec.Embeddings.Gateway != "" {
			reqs[RequiredGatewayKeys] = Requirement{"v1", "Secret", ns, x.Spec.Embeddings.Gateway + "-keys"}
		}
	}
	return reqs
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
	Ready    bool   `json:"ready"`
}

type Status struct {
	Ready          bool         `json:"ready"`
	Message        string       `json:"message"`
	ActiveSite     string       `json:"activeSite"`
	Endpoint       string       `json:"endpoint"`
	KeysSecret     string       `json:"keysSecret"`
	Clients        int          `json:"clients"`
	Tools          []string     `json:"tools"`
	ToolCount      int          `json:"toolCount"`
	Database       string       `json:"database"`
	DashboardUID   string       `json:"dashboardUid,omitempty"`
	ExpiredClients []string     `json:"expiredClients,omitempty"`
	Sites          []SiteStatus `json:"sites"`
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

// Endpoint is the MCP endpoint of server name in namespace, the same in
// every site's location.
func Endpoint(name, namespace string) string {
	return fmt.Sprintf("http://%s.%s.svc/mcp", name, namespace)
}

// KeysSecret is the Secret with the clients' API keys.
func KeysSecret(name string) string { return name + "-keys" }

type composition struct {
	spec     *Spec
	name, ns string
	observed map[string]Object
	required map[string][]Object
	labels   map[string]string
}

// Compose renders the desired state of an MCPServer.
func Compose(in Input) (*Output, error) {
	var xr XR
	decode(in.XR, &xr)
	c := &composition{spec: &xr.Spec, name: xr.Metadata.Name, ns: xr.Metadata.Namespace,
		observed: in.Observed, required: in.Required}
	c.labels = map[string]string{
		"app.kubernetes.io/managed-by": "crossplane",
		"app.kubernetes.io/part-of":    "basis",
		"ai.cndev.nl/mcpserver":        c.name,
	}
	spec := c.spec
	out := &Output{Composed: map[string]Composed{}}
	var problems []string

	// ---- sites: pinned in status.sites, else the Project's locations
	project := c.first(RequiredProject)
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

	// ---- the database, and where its primary is
	db := c.first(RequiredDatabase)
	kind, dbName := "GenAIStack", spec.Database.Stack
	if spec.Database.Cluster != "" {
		kind, dbName = "PostgresCluster", spec.Database.Cluster
	}
	active := SiteProtected
	switch {
	case db == nil:
		problems = append(problems, fmt.Sprintf("no %s %s in namespace %s (spec.database)", kind, dbName, c.ns))
	case kind == "GenAIStack":
		if dig(db, "status", "activeSite") == SiteRecovery && spec.Recovery.Enabled {
			active = SiteRecovery
		}
		if spec.Recovery.Enabled && dig(db, "spec", "recovery", "enabled") != true {
			problems = append(problems, fmt.Sprintf("GenAIStack %s has no recovery site; set its spec.recovery.enabled", dbName))
		}
		if spec.embeds() && dig(db, "spec", "gateway", "enabled") == false {
			problems = append(problems, fmt.Sprintf("GenAIStack %s has no gateway for the embeddings (spec.gateway.enabled)", dbName))
		}
	default:
		if dig(db, "status", "primarySite") == SiteRecovery && spec.Recovery.Enabled {
			active = SiteRecovery
		}
		if spec.Recovery.Enabled && dig(db, "spec", "geoReplication", "enabled") != true {
			problems = append(problems, fmt.Sprintf("PostgresCluster %s isn't geo-replicated; set its spec.geoReplication.enabled", dbName))
		}
	}
	if spec.Database.Cluster != "" && spec.embeds() {
		if c.requiredSecret(RequiredGatewayKeys, spec.embeddingsClient(c.name)) == "" {
			problems = append(problems, fmt.Sprintf("ModelGateway %s has no client %s for the embeddings; add it to its spec.clients",
				spec.Embeddings.Gateway, spec.embeddingsClient(c.name)))
		}
	}

	// ---- control plane: a key per client, the dashboard
	keys := map[string]string{}
	status := Status{ActiveSite: active, Endpoint: Endpoint(c.name, c.ns), KeysSecret: KeysSecret(c.name),
		Tools: c.tools(), Database: kind + "/" + dbName, Sites: []SiteStatus{}}
	for _, cl := range spec.clientList() {
		if cl.expired() {
			status.ExpiredClients = append(status.ExpiredClients, cl.Name)
			continue
		}
		keys[cl.Name] = b64(c.keep("keys", cl.Name))
	}
	status.Clients, status.ToolCount = len(keys), len(status.Tools)
	out.Composed["keys"] = Composed{Ready: c.observed["keys"] != nil, Object: Object{
		"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
		"metadata": c.meta(KeysSecret(c.name)), "data": keys,
	}}
	dashboard := c.dashboard()
	out.Composed["dashboard"] = Composed{Ready: true, Object: dashboard}
	status.DashboardUID = dig(dashboard, "spec", "uid").(string)

	// ---- each site: the server in its location
	allReady := out.Composed["keys"].Ready
	var waiting []string
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
		ss.Ready = true
		for key, o := range c.siteObjects(s, replicas) {
			k := s + "-" + key
			w := c.wrap(k, loc, o.manifest, o.copyFrom)
			w.Ready = o.ready(c.observed[k])
			out.Composed[k] = w
			ss.Ready = ss.Ready && w.Ready
		}
		if !ss.Ready {
			waiting = append(waiting, fmt.Sprintf("%s (%s)", s, loc))
		}
		allReady = allReady && ss.Ready
		status.Sites = append(status.Sites, ss)
	}
	allReady = allReady && len(problems) == 0

	status.Ready = allReady
	cond := Condition{Status: allReady, Reason: "Available"}
	switch {
	case len(problems) > 0:
		status.Message = strings.Join(problems, "; ")
		cond.Reason = "Waiting"
	case !allReady && len(waiting) > 0:
		// The pods are ready once the server has its database and tables:
		// what it waits for is in its log (and basis_mcp_database_ready).
		status.Message = "Waiting for the server's pods to be ready (database and tables) in " + strings.Join(waiting, ", ")
		cond.Reason = "Creating"
	case !allReady:
		status.Message = "Waiting for the clients' keys"
		cond.Reason = "Creating"
	default:
		status.Message = fmt.Sprintf("MCP server %s is ready with %d tool(s) over %s/%s; active site %s", c.name, len(status.Tools), kind, dbName, active)
	}
	cond.Message = status.Message
	out.Status, out.Condition = status, cond
	return out, nil
}

// tools are the tools the server serves.
func (c *composition) tools() []string {
	spec := c.spec
	var out []string
	if spec.retrieval() {
		out = append(out, "search", "fetch")
		if spec.Retrieval.Ingest {
			out = append(out, "add_document", "delete_document")
		}
	}
	if spec.memory() {
		out = append(out, "remember", "recall", "forget")
	}
	if out == nil {
		out = []string{}
	}
	return out
}

// config is basis-mcp's config.json for a site.
func (c *composition) config(site string) Object {
	spec := c.spec
	r := spec.Retrieval
	retrieval := Object{"enabled": spec.retrieval(), "mode": spec.mode(), "topK": or(r.TopK, 8),
		"textSearchConfig": or(r.TextSearchConfig, "simple"), "ingest": r.Ingest}
	if r.Table != "" {
		cols := Object{"id": or(r.Columns.ID, "id"), "content": or(r.Columns.Content, "content")}
		for k, v := range map[string]string{"title": r.Columns.Title, "source": r.Columns.Source,
			"metadata": r.Columns.Metadata, "embedding": r.Columns.Embedding} {
			if v != "" {
				cols[k] = v
			}
		}
		retrieval["table"], retrieval["own"], retrieval["columns"] = r.Table, false, cols
	} else {
		retrieval["table"], retrieval["own"] = "mcp.documents", true
	}
	memory := Object{"enabled": spec.memory(), "table": "mcp.memories", "scope": or(spec.Memory.Scope, "client")}
	if spec.Memory.RetentionDays > 0 {
		memory["retentionDays"] = spec.Memory.RetentionDays
	}
	embeddings := Object{}
	if spec.embeds() {
		embeddings["model"] = spec.Embeddings.Model
		if spec.Embeddings.Dimensions > 0 {
			embeddings["dimensions"] = spec.Embeddings.Dimensions
		}
	}
	clients := Object{}
	for _, cl := range spec.clientList() {
		if cl.expired() {
			continue
		}
		tools := []any{}
		for _, t := range cl.Tools {
			tools = append(tools, t)
		}
		clients[cl.Name] = Object{"tools": tools}
	}
	return Object{"server": c.name, "namespace": c.ns, "site": site,
		"retrieval": retrieval, "memory": memory, "embeddings": embeddings, "clients": clients}
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

// always: serving doesn't wait for it (metrics, alerts).
func always(Object) bool { return true }

func objectReady(o Object) bool { return conditionTrue(o, "Ready") }

// live is the manifest as the location reports it.
func live(o Object) Object {
	m, _ := dig(o, "status", "atProvider", "manifest").(Object)
	return m
}

// Secrets in the location for a cluster's database: the role's
// credentials, the server's key at the embeddings gateway.
func (c *composition) databaseSecret() string   { return c.name + "-database" }
func (c *composition) embeddingsSecret() string { return c.name + "-embeddings" }

// siteObjects are what runs in a site's location, by composition resource
// name (without the site prefix).
func (c *composition) siteObjects(site string, replicas int) map[string]object {
	spec := c.spec
	out := map[string]object{}
	out["keys"] = object{ready: objectReady, copyFrom: &copySpec{from: KeysSecret(c.name)},
		manifest: Object{"apiVersion": "v1", "kind": "Secret", "metadata": c.meta(KeysSecret(c.name))}}
	cfg, _ := json.MarshalIndent(c.config(site), "", "  ")
	out["config"] = object{ready: reported, manifest: Object{
		"apiVersion": "v1", "kind": "ConfigMap", "metadata": c.meta(c.name + "-config"),
		"data": Object{"config.json": string(cfg)},
	}}

	// The database and the embeddings endpoint, from the environment.
	var env, envFrom []any
	secretEnv := func(name, secret, key string) Object {
		return Object{"name": name, "valueFrom": Object{"secretKeyRef": Object{"name": secret, "key": key}}}
	}
	if stack := spec.Database.Stack; stack != "" {
		// DATABASE_URL, OPENAI_BASE_URL and OPENAI_API_KEY (and the cache's, unused).
		envFrom = append(envFrom, Object{"secretRef": Object{"name": stack + "-connection"}})
	} else {
		cluster := spec.Database.Cluster
		credentials := cluster + "-app"
		if ref := spec.Database.CredentialsSecretRef; ref != nil {
			credentials = c.databaseSecret()
			out["database"] = object{ready: objectReady, copyFrom: &copySpec{from: ref.Name},
				manifest: Object{"apiVersion": "v1", "kind": "Secret", "metadata": c.meta(c.databaseSecret())}}
		}
		// libpq's variables: pgx reads them for what the URL leaves out.
		env = append(env,
			Object{"name": "DATABASE_URL", "value": fmt.Sprintf("postgresql://%s-rw.%s.svc:5432/%s", cluster, c.ns, spec.databaseName())},
			secretEnv("PGUSER", credentials, "username"), secretEnv("PGPASSWORD", credentials, "password"))
		if spec.embeds() {
			gw := spec.Embeddings.Gateway
			out["embeddings"] = object{ready: objectReady,
				copyFrom: &copySpec{from: gw + "-keys", field: "data." + spec.embeddingsClient(c.name), toField: "data.apiKey"},
				manifest: Object{"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": c.meta(c.embeddingsSecret())}}
			env = append(env, Object{"name": "OPENAI_BASE_URL", "value": fmt.Sprintf("http://%s.%s.svc/v1", gw, c.ns)},
				secretEnv("OPENAI_API_KEY", c.embeddingsSecret(), "apiKey"))
		}
	}

	selector := map[string]string{"app.kubernetes.io/name": "basis-mcp", "ai.cndev.nl/mcpserver": c.name}
	podLabels := map[string]string{"app.kubernetes.io/part-of": "basis"}
	for k, v := range selector {
		podLabels[k] = v
	}
	image := or(spec.Image, DefaultImage)
	probe := func(path string, period int) Object {
		return Object{"httpGet": Object{"path": path, "port": "http"}, "periodSeconds": period, "timeoutSeconds": 3}
	}
	container := Object{
		"name": "server", "image": image,
		"args":  []any{"--config=/etc/basis-mcp/config/config.json", "--keys=/etc/basis-mcp/keys"},
		"ports": []any{Object{"name": "http", "containerPort": HTTPPort}, Object{"name": "metrics", "containerPort": MetricsPort}},
		// Ready once it has its database and tables (and its model): a
		// gateway or agent only gets pods that can answer.
		"readinessProbe": probe("/readyz", 10),
		"livenessProbe":  probe("/healthz", 20),
		"resources": Object{"requests": Object{"cpu": spec.cpu(), "memory": spec.memoryLimit()},
			"limits": Object{"memory": spec.memoryLimit()}},
		"securityContext": Object{"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true,
			"capabilities": Object{"drop": []any{"ALL"}}},
		"volumeMounts": []any{
			Object{"name": "config", "mountPath": "/etc/basis-mcp/config", "readOnly": true},
			Object{"name": "keys", "mountPath": "/etc/basis-mcp/keys", "readOnly": true},
		},
	}
	if len(env) > 0 {
		container["env"] = env
	}
	if len(envFrom) > 0 {
		container["envFrom"] = envFrom
	}
	out["deployment"] = object{ready: func(o Object) bool {
		if replicas == 0 {
			return reported(o)
		}
		n, _ := dig(live(o), "status", "readyReplicas").(float64)
		return n >= 1
	}, manifest: Object{
		"apiVersion": "apps/v1", "kind": "Deployment", "metadata": c.meta(c.name),
		"spec": Object{
			"replicas": replicas,
			"selector": Object{"matchLabels": selector},
			"template": Object{
				"metadata": Object{"labels": podLabels,
					// A new config is a rollout; new keys are read in place.
					"annotations": map[string]string{"ai.cndev.nl/config-hash": sha1hex(string(cfg) + image)[:16]}},
				"spec": Object{
					"automountServiceAccountToken": false,
					"securityContext": Object{"runAsNonRoot": true, "runAsUser": 65532, "runAsGroup": 65532, "fsGroup": 65532,
						"seccompProfile": Object{"type": "RuntimeDefault"}},
					"topologySpreadConstraints": []any{Object{"maxSkew": 1, "topologyKey": "kubernetes.io/hostname",
						"whenUnsatisfiable": "ScheduleAnyway", "labelSelector": Object{"matchLabels": selector}}},
					"containers": []any{container},
					"volumes": []any{
						Object{"name": "config", "configMap": Object{"name": c.name + "-config"}},
						Object{"name": "keys", "secret": Object{"secretName": KeysSecret(c.name), "defaultMode": 0o440}},
					},
				},
			},
		},
	}}
	out["service"] = object{ready: reported, manifest: Object{
		"apiVersion": "v1", "kind": "Service", "metadata": c.meta(c.name),
		"spec": Object{"type": "ClusterIP", "selector": selector,
			"ports": []any{Object{"name": "http", "port": 80, "targetPort": "http", "appProtocol": "http"}}},
	}}
	if replicas > 1 {
		out["pdb"] = object{ready: always, manifest: Object{
			"apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": c.meta(c.name),
			"spec": Object{"minAvailable": 1, "selector": Object{"matchLabels": selector}},
		}}
	}
	out["podmonitor"] = object{ready: always, manifest: c.podMonitor(selector)}
	if !spec.Alerts.Disabled && replicas > 0 {
		out["prometheusrule"] = object{ready: always, manifest: c.alertRules()}
	}
	return out
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

// first is a requirement's resource, nil until it resolves.
func (c *composition) first(requirement string) Object {
	if items := c.required[requirement]; len(items) > 0 {
		return items[0]
	}
	return nil
}

// requiredSecret reads a field of a required Secret, "" until it exists.
func (c *composition) requiredSecret(requirement, field string) string {
	enc, _ := dig(c.first(requirement), "data", field).(string)
	raw, _ := base64.StdEncoding.DecodeString(enc)
	return string(raw)
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
