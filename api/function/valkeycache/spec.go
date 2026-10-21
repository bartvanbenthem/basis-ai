package valkeycache

// The ValkeyCache XR, as far as the composition reads it. Fields mirror
// apis/valkeycache/definition.yaml. The API server applies the XRD defaults;
// the accessors below apply them again so `crossplane render` and objects
// created before a default existed come out the same.

// XR is the observed ValkeyCache.
type XR struct {
	Metadata struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	} `json:"metadata"`
	Spec   Spec `json:"spec"`
	Status struct {
		Location string `json:"location"`
	} `json:"status"`
}

type Spec struct {
	Site      string `json:"site"`
	Mode      string `json:"mode"`
	Shards    int    `json:"shards"`
	Replicas  *int   `json:"replicas"`
	Resources struct {
		CPU    string `json:"cpu"`
		Memory string `json:"memory"`
	} `json:"resources"`
	MaxMemoryPercent int        `json:"maxMemoryPercent"`
	EvictionPolicy   string     `json:"evictionPolicy"`
	Monitoring       Monitoring `json:"monitoring"`
}

type Monitoring struct {
	Enabled          *bool             `json:"enabled"`
	PodMonitorLabels map[string]string `json:"podMonitorLabels"`
	PrometheusRule   struct {
		Enabled      *bool    `json:"enabled"`
		ExcludeRules []string `json:"excludeRules"`
	} `json:"prometheusRule"`
	GrafanaDashboard struct {
		Enabled                   *bool             `json:"enabled"`
		InstanceSelector          map[string]string `json:"instanceSelector"`
		AllowCrossNamespaceImport bool              `json:"allowCrossNamespaceImport"`
		Folder                    string            `json:"folder"`
		DatasourceName            string            `json:"datasourceName"`
	} `json:"grafanaDashboard"`
}

// Sites (spec.site): which of the Project's locations the cache runs in.
const (
	SiteProtected = "protected"
	SiteRecovery  = "recovery"
)

// Modes (spec.mode).
const (
	ModeExact    = "exact"
	ModeSemantic = "semantic"
)

func or[T comparable](v, def T) T {
	var zero T
	if v == zero {
		return def
	}
	return v
}

func orTrue(b *bool) bool { return b == nil || *b }

func (s *Spec) site() string      { return or(s.Site, SiteProtected) }
func (s *Spec) mode() string      { return or(s.Mode, ModeExact) }
func (s *Spec) semantic() bool    { return s.mode() == ModeSemantic }
func (s *Spec) shards() int       { return or(s.Shards, 1) }
func (s *Spec) cpu() string       { return or(s.Resources.CPU, "500m") }
func (s *Spec) memory() string    { return or(s.Resources.Memory, "1Gi") }
func (s *Spec) maxMemoryPct() int { return or(s.MaxMemoryPercent, 75) }
func (s *Spec) evictionPolicy() string {
	return or(s.EvictionPolicy, "allkeys-lru")
}

func (s *Spec) replicas() int {
	if s.Replicas == nil {
		return 1
	}
	return *s.Replicas
}

func (m *Monitoring) enabled() bool   { return orTrue(m.Enabled) }
func (m *Monitoring) rules() bool     { return m.enabled() && orTrue(m.PrometheusRule.Enabled) }
func (m *Monitoring) dashboard() bool { return orTrue(m.GrafanaDashboard.Enabled) }
