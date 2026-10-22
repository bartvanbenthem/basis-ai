package genaistack

// The GenAIStack XR, as far as the composition reads it. Fields mirror
// apis/genaistack/definition.yaml; the accessors repeat the XRD defaults so
// `crossplane render` and older objects come out the same.

type XR struct {
	Metadata struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	} `json:"metadata"`
	Spec   Spec `json:"spec"`
	Status struct {
		Sites []SiteStatus `json:"sites"`
	} `json:"status"`
}

type Spec struct {
	Recovery struct {
		Enabled         bool   `json:"enabled"`
		ActiveSite      string `json:"activeSite"`
		Promotion       string `json:"promotion"`
		CacheMemory     string `json:"cacheMemory"`
		GatewayReplicas *int   `json:"gatewayReplicas"`
	} `json:"recovery"`
	Retrieval struct {
		Size        string    `json:"size"`
		Instances   int       `json:"instances"`
		StorageSize string    `json:"storageSize"`
		Backup      bool      `json:"backup"`
		Extensions  *[]string `json:"extensions"`
		// AuditLog is pgaudit.log for the database; empty, no audit logging.
		AuditLog string `json:"auditLog"`
		// Expose goes to the PostgresCluster's spec.expose as it is.
		Expose Object `json:"expose"`
	} `json:"retrieval"`
	Cache struct {
		Enabled        *bool  `json:"enabled"`
		Mode           string `json:"mode"`
		CPU            string `json:"cpu"`
		Memory         string `json:"memory"`
		EvictionPolicy string `json:"evictionPolicy"`
	} `json:"cache"`
	Gateway struct {
		Enabled  *bool `json:"enabled"`
		Replicas int   `json:"replicas"`
		// Models go to the stack's own ModelGateway as they are.
		Models []any `json:"models"`
		// Ref names a ModelGateway in the namespace to use instead of one
		// of the stack's own; Client is the stack's client there.
		Ref    string `json:"ref"`
		Client string `json:"client"`
		// Expose goes to the stack's own ModelGateway's spec.expose as it is.
		Expose Object `json:"expose"`
		// MonthlyTokens caps the stack's own gateway per month.
		MonthlyTokens int64 `json:"monthlyTokens"`
		// Retry, RateLimit and Alerts go to the stack's own gateway as they are.
		Retry     Object `json:"retry"`
		RateLimit Object `json:"rateLimit"`
		Alerts    Object `json:"alerts"`
	} `json:"gateway"`
}

// Sites of a Project (spec.locations).
const (
	SiteProtected = "protected"
	SiteRecovery  = "recovery"
)

func or[T comparable](v, def T) T {
	var zero T
	if v == zero {
		return def
	}
	return v
}

func orTrue(b *bool) bool { return b == nil || *b }

func (s *Spec) cacheEnabled() bool    { return orTrue(s.Cache.Enabled) }
func (s *Spec) gatewayEnabled() bool  { return orTrue(s.Gateway.Enabled) }
func (s *Spec) cacheMode() string     { return or(s.Cache.Mode, "semantic") }
func (s *Spec) cacheCPU() string      { return or(s.Cache.CPU, "500m") }
func (s *Spec) cacheMemory() string   { return or(s.Cache.Memory, "1Gi") }
func (s *Spec) standbyMemory() string { return or(s.Recovery.CacheMemory, "512Mi") }
func (s *Spec) eviction() string      { return or(s.Cache.EvictionPolicy, "allkeys-lru") }
func (s *Spec) gatewayReplicas() int  { return or(s.Gateway.Replicas, 2) }
func (s *Spec) primarySite() string   { return or(s.Recovery.ActiveSite, SiteProtected) }
func (s *Spec) instances() int        { return or(s.Retrieval.Instances, 3) }
func (s *Spec) storageSize() string   { return or(s.Retrieval.StorageSize, "20Gi") }

func (s *Spec) standbyGatewayReplicas() int {
	if s.Recovery.GatewayReplicas == nil {
		return 1
	}
	return *s.Recovery.GatewayReplicas
}

func (s *Spec) extensions() []string {
	if s.Retrieval.Extensions == nil {
		return []string{"vector"}
	}
	return *s.Retrieval.Extensions
}

// gateway is the ModelGateway the stack uses and its client there: its own
// <name>-gateway (client apps), or spec.gateway.ref.
func (s *Spec) gateway(stack string) (name, client string, own bool) {
	if s.Gateway.Ref != "" {
		return s.Gateway.Ref, or(s.Gateway.Client, stack), false
	}
	return stack + "-gateway", "apps", true
}
