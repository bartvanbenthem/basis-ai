// Package genaistack composes a GenAIStack (ai.cndev.nl/v1alpha1): the
// platform side of a generative AI service in a Project, in its protected
// site and optionally a warm standby in its recovery site.
//
// On the control plane, next to the XR, labelled ai.cndev.nl/genaistack:
// <name>, which the admission policy reads to keep them the stack's:
//
//	database           PostgresCluster <name>-db: profile vector, PostgreSQL 18,
//	                   the stack's own role <name>_stack (member of the
//	                   database owner), geo-replicated with recovery, its
//	                   primary site spec.recovery.activeSite
//	db-credentials     Secret <name>-db-credentials (basic-auth) for that role:
//	                   generated once, then kept; the PostgresCluster copies it
//	                   to its locations, so the stack knows the password
//	cache, cache-dr    ValkeyCache <name>-cache (protected) and <name>-cache-dr
//	                   (recovery): one node each, so plain clients work
//	gateway            ModelGateway <name>-gateway (client "apps"), unless
//	                   spec.gateway.ref names one to share (client
//	                   spec.gateway.client, the stack's name by default)
//
// spec.retrieval.expose and spec.gateway.expose go to the database's and the
// gateway's spec.expose: a LoadBalancer for clients outside the location.
//
//	connection-<site>  Secret <name>-connection-<site>: the site's wiring
//
// In each site's location (a provider-kubernetes Object, prefix "<site>-"):
//
//	connection         Secret <name>-connection, data from connection-<site>
//
// Active site: where the database's primary runs (its status.primarySite).
// It gets the full-size cache and gateway, the standby site a small cache and
// a minimal gateway, so a switchover of the database moves the stack along.
package genaistack

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/url"
	"strconv"
	"strings"
)

// Requirement names.
const (
	RequiredProject       = "project"
	RequiredCacheSecret   = "cache-secret"
	RequiredDRCacheSecret = "cache-dr-secret"
	RequiredGatewayKeys   = "gateway-keys"
	RequiredGateway       = "gateway"
)

// OwnerLabel marks what a stack composes next to it as the stack's.
const OwnerLabel = "ai.cndev.nl/genaistack"

type Object = map[string]any

// Requirement is a resource the composition needs to see; Namespace empty
// for a cluster-scoped one.
type Requirement struct {
	APIVersion, Kind, Namespace, Name string
}

// Requirements: the Project (its sites), the caches' password Secrets, the
// gateway's keys and, for a shared gateway, the ModelGateway itself.
func Requirements(xr Object) map[string]Requirement {
	var x XR
	decode(xr, &x)
	ns, name := x.Metadata.Namespace, x.Metadata.Name
	reqs := map[string]Requirement{
		RequiredProject:       {"platform.cndev.nl/v1alpha1", "Project", "", ns},
		RequiredCacheSecret:   {"v1", "Secret", ns, name + "-cache-valkey"},
		RequiredDRCacheSecret: {"v1", "Secret", ns, name + "-cache-dr-valkey"},
	}
	if x.Spec.gatewayEnabled() {
		gw, _, own := x.Spec.gateway(name)
		reqs[RequiredGatewayKeys] = Requirement{"v1", "Secret", ns, gw + "-keys"}
		if !own {
			reqs[RequiredGateway] = Requirement{"ai.cndev.nl/v1alpha1", "ModelGateway", ns, gw}
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
	Site             string `json:"site"`
	Location         string `json:"location"`
	Active           bool   `json:"active"`
	GatewayEndpoint  string `json:"gatewayEndpoint,omitempty"`
	DatabaseEndpoint string `json:"databaseEndpoint"`
	CacheEndpoint    string `json:"cacheEndpoint,omitempty"`
}

type Status struct {
	Ready      bool   `json:"ready"`
	Message    string `json:"message"`
	ActiveSite string `json:"activeSite"`
	Models     int    `json:"models"`
	// The gateway's base URL outside the location, when it is exposed.
	GatewayExternalEndpoint string            `json:"gatewayExternalEndpoint,omitempty"`
	ConnectionSecret        string            `json:"connectionSecret"`
	Components              map[string]string `json:"components"`
	Sites                   []SiteStatus      `json:"sites"`
}

type Output struct {
	Composed  map[string]Composed
	Status    Status
	Condition Condition
}

// NewSecret generates passwords; tests replace it.
var NewSecret = func() string {
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

type composition struct {
	xr       XR
	spec     *Spec
	name, ns string
	observed map[string]Object
	required map[string][]Object
	labels   map[string]string
}

// site is one of the stack's sites in this reconcile.
type site struct {
	name, location string
	active         bool
	cache          string // the site's ValkeyCache
	cacheSecret    string // requirement name of its password Secret
}

// Compose renders the desired state of a GenAIStack.
func Compose(in Input) (*Output, error) {
	c := &composition{observed: in.Observed, required: in.Required}
	decode(in.XR, &c.xr)
	c.spec = &c.xr.Spec
	c.name, c.ns = c.xr.Metadata.Name, c.xr.Metadata.Namespace
	c.labels = map[string]string{
		"app.kubernetes.io/managed-by": "crossplane",
		"app.kubernetes.io/part-of":    "basis",
		OwnerLabel:                     c.name,
	}
	spec := c.spec
	out := &Output{Composed: map[string]Composed{}}

	// ---- sites: pinned in status.sites, else the Project's locations
	var project Object
	if p := in.Required[RequiredProject]; len(p) > 0 {
		project = p[0]
	}
	pinned := map[string]string{}
	for _, s := range c.xr.Status.Sites {
		pinned[s.Site] = s.Location
	}
	location := func(s string) string {
		l, _ := dig(project, "spec", "locations", s).(string)
		return or(pinned[s], l)
	}
	// The active site follows the database's primary.
	active := SiteProtected
	if ps, _ := dig(c.observed["database"], "status", "primarySite").(string); ps == SiteRecovery && spec.Recovery.Enabled {
		active = SiteRecovery
	}
	sites := []site{{name: SiteProtected, location: location(SiteProtected), cache: c.name + "-cache", cacheSecret: RequiredCacheSecret}}
	if spec.Recovery.Enabled {
		sites = append(sites, site{name: SiteRecovery, location: location(SiteRecovery), cache: c.name + "-cache-dr", cacheSecret: RequiredDRCacheSecret})
	}
	for i := range sites {
		sites[i].active = sites[i].name == active
	}

	// ---- control plane: credentials, the child APIs
	var problems []string
	role := strings.ReplaceAll(c.name, "-", "_") + "_stack"
	dbPassword := c.keep("db-credentials", "password")
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	out.Composed["db-credentials"] = Composed{Ready: c.observed["db-credentials"] != nil, Object: Object{
		"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/basic-auth",
		"metadata": c.meta(c.name + "-db-credentials"),
		"data":     map[string]string{"username": b64(role), "password": b64(dbPassword)},
	}}

	backup := spec.Retrieval.Backup || spec.Recovery.Enabled
	geo := Object{"enabled": spec.Recovery.Enabled, "primarySite": SiteProtected}
	if spec.Recovery.Enabled {
		// The stack's switchover: the database moves its primary, the stack
		// follows once it has (status.primarySite).
		geo["primarySite"] = spec.primarySite()
		if spec.Recovery.Promotion != "" {
			geo["promotion"] = spec.Recovery.Promotion
		}
	}
	dbSpec := Object{
		"profile":         "vector",
		"postgresVersion": 18,
		"instances":       spec.instances(),
		"storage":         Object{"size": spec.storageSize()},
		"database":        Object{"extensions": spec.extensions()},
		"roles":           []any{Object{"name": role, "passwordSecret": c.name + "-db-credentials", "inRoles": []any{"app"}}},
		"backup":          Object{"enabled": backup},
		"geoReplication":  geo,
	}
	if spec.Retrieval.Size != "" {
		dbSpec["size"] = spec.Retrieval.Size
	}
	if len(spec.Retrieval.Expose) > 0 {
		dbSpec["expose"] = spec.Retrieval.Expose
	}
	// pgaudit: setting pgaudit.log is what loads it (the PostgresCluster's
	// spec.postgresql.parameters, as a standalone cluster does it).
	if a := strings.TrimSpace(spec.Retrieval.AuditLog); a != "" {
		dbSpec["postgresql"] = Object{"parameters": Object{"pgaudit.log": a}}
	}
	out.Composed["database"] = Composed{Ready: conditionTrue(c.observed["database"], "Ready"), Object: Object{
		"apiVersion": "postgres.cndev.nl/v1alpha1", "kind": "PostgresCluster",
		"metadata": c.meta(c.name + "-db"), "spec": dbSpec,
	}}
	if spec.cacheEnabled() {
		for _, s := range sites {
			memory := spec.standbyMemory()
			if s.active {
				memory = spec.cacheMemory()
			}
			key := "cache"
			if s.name == SiteRecovery {
				key = "cache-dr"
			}
			out.Composed[key] = Composed{Ready: conditionTrue(c.observed[key], "Ready"), Object: Object{
				"apiVersion": "cache.cndev.nl/v1alpha1", "kind": "ValkeyCache",
				"metadata": c.meta(s.cache),
				"spec": Object{
					"site": s.name, "mode": spec.cacheMode(),
					// One node: the Service always reaches the primary, so clients
					// without cluster support work too.
					"shards": 1, "replicas": 0,
					"resources":      Object{"cpu": spec.cacheCPU(), "memory": memory},
					"evictionPolicy": spec.eviction(),
				},
			}}
		}
	}

	// ---- the gateway: the stack's own ModelGateway, or a shared one
	status := Status{ActiveSite: active, ConnectionSecret: c.name + "-connection",
		Components: map[string]string{"database": c.name + "-db"}, Sites: []SiteStatus{}}
	gatewayKey, gatewayReady := "", true
	gwName, client, own := spec.gateway(c.name)
	if spec.gatewayEnabled() {
		status.Components["gateway"] = gwName
		if own {
			status.Models = len(spec.Gateway.Models)
			models := spec.Gateway.Models
			if models == nil {
				models = []any{}
			}
			gwSpec := Object{
				"replicas":   spec.gatewayReplicas(),
				"recovery":   Object{"enabled": spec.Recovery.Enabled, "replicas": spec.standbyGatewayReplicas()},
				"activeSite": active,
				"clients":    []any{Object{"name": client}},
				"models":     models,
			}
			if len(spec.Gateway.Expose) > 0 {
				gwSpec["expose"] = spec.Gateway.Expose
			}
			if spec.Gateway.MonthlyTokens > 0 {
				gwSpec["monthlyTokens"] = spec.Gateway.MonthlyTokens
			}
			for k, v := range map[string]Object{"retry": spec.Gateway.Retry, "rateLimit": spec.Gateway.RateLimit, "alerts": spec.Gateway.Alerts} {
				if len(v) > 0 {
					gwSpec[k] = v
				}
			}
			out.Composed["gateway"] = Composed{Ready: conditionTrue(c.observed["gateway"], "Ready"), Object: Object{
				"apiVersion": "ai.cndev.nl/v1alpha1", "kind": "ModelGateway",
				"metadata": c.meta(gwName), "spec": gwSpec,
			}}
			gatewayReady = out.Composed["gateway"].Ready
			status.GatewayExternalEndpoint, _ = dig(c.observed["gateway"], "status", "externalEndpoint").(string)
		} else {
			var gw Object
			if items := c.required[RequiredGateway]; len(items) > 0 {
				gw = items[0]
			}
			m, _ := dig(gw, "status", "models").(float64)
			status.Models = int(m)
			status.GatewayExternalEndpoint, _ = dig(gw, "status", "externalEndpoint").(string)
			gatewayReady = gw != nil && conditionTrue(gw, "Ready")
			switch {
			case gw == nil:
				problems = append(problems, fmt.Sprintf("no ModelGateway %s in namespace %s (spec.gateway.ref)", gwName, c.ns))
			case spec.Recovery.Enabled && dig(gw, "spec", "recovery", "enabled") != true:
				problems = append(problems, fmt.Sprintf("ModelGateway %s has no recovery site; set its spec.recovery.enabled", gwName))
			}
		}
		gatewayKey = c.requiredSecret(RequiredGatewayKeys, client)
		if gatewayKey == "" {
			if own {
				problems = append(problems, fmt.Sprintf("waiting for ModelGateway %s's key", gwName))
			} else {
				problems = append(problems, fmt.Sprintf("ModelGateway %s has no client %s; add it to its spec.clients", gwName, client))
			}
		}
	}

	// ---- each site: the wiring in its location
	if spec.cacheEnabled() {
		status.Components["cache"] = c.name + "-cache"
		if spec.Recovery.Enabled {
			status.Components["recoveryCache"] = c.name + "-cache-dr"
		}
	}
	dbHost := fmt.Sprintf("%s-db-rw.%s.svc", c.name, c.ns)
	gatewayEndpoint := fmt.Sprintf("http://%s.%s.svc/v1", gwName, c.ns)
	allReady := out.Composed["database"].Ready && gatewayReady
	for _, s := range sites {
		ss := SiteStatus{Site: s.name, Location: s.location, Active: s.active, DatabaseEndpoint: dbHost + ":5432"}
		if s.location == "" {
			problems = append(problems, fmt.Sprintf("Project %s has no %s location (spec.locations.%s)", c.ns, s.name, s.name))
			status.Sites = append(status.Sites, ss)
			allReady = false
			continue
		}
		conn := map[string]string{
			"SITE": s.name, "ACTIVE": strconv.FormatBool(s.active),
			"DATABASE_HOST": dbHost, "DATABASE_PORT": "5432", "DATABASE_NAME": "app",
			"DATABASE_USER": role, "DATABASE_PASSWORD": dbPassword,
			"DATABASE_URL": fmt.Sprintf("postgresql://%s:%s@%s:5432/app", role, url.QueryEscape(dbPassword), dbHost),
		}
		if spec.cacheEnabled() {
			ss.CacheEndpoint = fmt.Sprintf("valkey-%s.%s.svc:6379", s.cache, c.ns)
			if pw := c.requiredSecret(s.cacheSecret, "password"); pw != "" {
				host := fmt.Sprintf("valkey-%s.%s.svc", s.cache, c.ns)
				conn["VALKEY_HOST"], conn["VALKEY_PORT"], conn["VALKEY_PASSWORD"] = host, "6379", pw
				conn["VALKEY_URL"] = fmt.Sprintf("valkey://default:%s@%s:6379", pw, host)
				conn["VALKEY_CLUSTER"] = "false"
			} else {
				problems = append(problems, fmt.Sprintf("waiting for cache %s's password", s.cache))
				allReady = false
			}
		}
		if spec.gatewayEnabled() {
			ss.GatewayEndpoint = gatewayEndpoint
			if gatewayKey != "" {
				conn["OPENAI_BASE_URL"], conn["OPENAI_API_KEY"] = gatewayEndpoint, gatewayKey
			}
		}
		data := map[string]string{}
		for k, v := range conn {
			data[k] = b64(v)
		}
		connKey := "connection-" + s.name
		out.Composed[connKey] = Composed{Ready: c.observed[connKey] != nil, Object: Object{
			"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
			"metadata": c.meta(c.name + "-connection-" + s.name), "data": data,
		}}

		k := s.name + "-connection"
		w := c.wrap(k, s.location, Object{"apiVersion": "v1", "kind": "Secret", "metadata": c.meta(c.name + "-connection")},
			c.name+"-connection-"+s.name)
		w.Ready = conditionTrue(c.observed[k], "Ready")
		out.Composed[k] = w
		allReady = allReady && w.Ready
		status.Sites = append(status.Sites, ss)
	}
	for _, key := range []string{"cache", "cache-dr", "db-credentials"} {
		if r, ok := out.Composed[key]; ok {
			allReady = allReady && r.Ready
		}
	}
	allReady = allReady && len(problems) == 0

	status.Ready = allReady
	cond := Condition{Status: allReady, Reason: "Available"}
	switch {
	case len(problems) > 0:
		status.Message = strings.Join(problems, "; ")
		cond.Reason = "Waiting"
	case !out.Composed["database"].Ready:
		status.Message = fmt.Sprintf("Waiting for PostgresCluster %s-db", c.name)
		cond.Reason = "Creating"
	case spec.Recovery.Enabled && spec.primarySite() != active:
		status.Message = fmt.Sprintf("Switching the active site to %s: waiting for PostgresCluster %s-db", spec.primarySite(), c.name)
		cond.Reason = "Switching"
	case !allReady:
		status.Message = "Waiting for the cache and gateway"
		cond.Reason = "Creating"
	default:
		status.Message = fmt.Sprintf("Stack %s is ready; active site %s", c.name, active)
	}
	cond.Message = status.Message
	out.Status, out.Condition = status, cond
	return out, nil
}

// wrap puts a Secret for a location into a provider-kubernetes Object; its
// data comes from Secret from on the control plane.
func (c *composition) wrap(key, location string, manifest Object, from string) Composed {
	// The Secret's data comes from the control plane, never through this spec.
	var refs []any
	for _, f := range []string{"data", "type"} {
		refs = append(refs, Object{"patchesFrom": Object{"apiVersion": "v1", "kind": "Secret",
			"name": from, "namespace": c.ns, "fieldPath": f}})
	}
	return Composed{Object: Object{
		"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
		"metadata": Object{"name": c.name + "-" + key, "namespace": c.ns, "labels": c.labels,
			"annotations": map[string]string{"platform.cndev.nl/location": location}},
		"spec": Object{
			"providerConfigRef": Object{"kind": "ClusterProviderConfig", "name": location},
			"watch":             true,
			"forProvider":       Object{"manifest": manifest},
			"references":        refs,
		},
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
	return NewSecret()
}

// requiredSecret reads a field of a required Secret, "" until it exists.
func (c *composition) requiredSecret(requirement, field string) string {
	items := c.required[requirement]
	if len(items) == 0 {
		return ""
	}
	enc, _ := dig(items[0], "data", field).(string)
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
