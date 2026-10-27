package modelserver

// The ModelServer XR, as far as the composition reads it. Fields mirror
// apis/modelserver/definition.yaml; the accessors repeat the XRD defaults so
// `crossplane render` and older objects come out the same.

type XR struct {
	Metadata struct {
		Name      string            `json:"name"`
		Namespace string            `json:"namespace"`
		Labels    map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec   Spec `json:"spec"`
	Status struct {
		Sites []SiteStatus `json:"sites"`
	} `json:"status"`
}

type Spec struct {
	Model     Model     `json:"model"`
	Replicas  *int      `json:"replicas"`
	Resources Resources `json:"resources"`
	// Image replaces KServe's vLLM image.
	Image string `json:"image"`
	// Args are extra vllm serve flags.
	Args    []string `json:"args"`
	Routing struct {
		PrefixCacheAware *bool `json:"prefixCacheAware"`
	} `json:"routing"`
	Scheduling struct {
		NodeSelector map[string]string `json:"nodeSelector"`
		Tolerations  []any             `json:"tolerations"`
	} `json:"scheduling"`
	Recovery struct {
		Enabled  bool `json:"enabled"`
		Replicas *int `json:"replicas"`
	} `json:"recovery"`
	Alerts Alerts `json:"alerts"`
}

type Model struct {
	URI  string `json:"uri"`
	Name string `json:"name"`
	// TokenSecretRef: a Hugging Face token for gated or private hf:// models.
	TokenSecretRef *SecretKey `json:"tokenSecretRef"`
}

type SecretKey struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

type Resources struct {
	CPU         string `json:"cpu"`
	Memory      string `json:"memory"`
	GPUs        *int   `json:"gpus"`
	GPUResource string `json:"gpuResource"`
}

// Alerts are the thresholds of the server's alerts.
type Alerts struct {
	// WaitingRequests: requests queued for a slot, all replicas together.
	WaitingRequests int `json:"waitingRequests"`
	// KVCacheUsagePercent: the fullest replica's KV cache.
	KVCacheUsagePercent float64 `json:"kvCacheUsagePercent"`
	// TimeToFirstTokenSeconds: the 95th percentile.
	TimeToFirstTokenSeconds float64 `json:"timeToFirstTokenSeconds"`
	// Disabled: no PrometheusRule.
	Disabled bool `json:"disabled"`
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

func orInt(v *int, def int) int {
	if v == nil {
		return def
	}
	return *v
}

func (s *Spec) replicas() int        { return orInt(s.Replicas, 1) }
func (s *Spec) standbyReplicas() int { return orInt(s.Recovery.Replicas, 1) }

// siteReplicas are the vLLM replicas in site.
func (s *Spec) siteReplicas(site string) int {
	if site == SiteRecovery {
		return s.standbyReplicas()
	}
	return s.replicas()
}

func (s *Spec) prefixCacheAware() bool {
	return s.Routing.PrefixCacheAware == nil || *s.Routing.PrefixCacheAware
}

func (r *Resources) cpu() string         { return or(r.CPU, "4") }
func (r *Resources) memory() string      { return or(r.Memory, "16Gi") }
func (r *Resources) gpus() int           { return orInt(r.GPUs, 1) }
func (r *Resources) gpuResource() string { return or(r.GPUResource, "nvidia.com/gpu") }

func (a Alerts) waiting() int            { return or(a.WaitingRequests, 10) }
func (a Alerts) kvCachePercent() float64 { return or(a.KVCacheUsagePercent, 95) }
func (a Alerts) firstToken() float64     { return or(a.TimeToFirstTokenSeconds, 10) }
