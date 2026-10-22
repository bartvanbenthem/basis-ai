package modelgateway

// The ModelGateway XR, as far as the composition reads it. Fields mirror
// apis/modelgateway/definition.yaml; the accessors repeat the XRD defaults so
// `crossplane render` and older objects come out the same.

import "time"

// Now is the clock client expiry is compared with; tests set it.
var Now = time.Now

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
	Replicas int `json:"replicas"`
	Recovery struct {
		Enabled  bool `json:"enabled"`
		Replicas *int `json:"replicas"`
	} `json:"recovery"`
	ActiveSite string    `json:"activeSite"`
	Clients    *[]Client `json:"clients"`
	Models     []Model   `json:"models"`
	Expose     *Expose   `json:"expose"`
	// MonthlyTokens caps the gateway's tokens per month, all clients together.
	MonthlyTokens int64 `json:"monthlyTokens"`
	// Retry: how often to try a model, and on what, before its fallbacks.
	Retry *Retry `json:"retry"`
	// RateLimit: per-minute caps for the gateway as a whole.
	RateLimit PerMinute `json:"rateLimit"`
	// Alerts: thresholds of the gateway's latency and error alerts.
	Alerts Alerts `json:"alerts"`
}

// Retry is how a failed request is retried: on the same model, then on its fallbacks.
type Retry struct {
	// Attempts per model, the first included; 1 is no retries.
	Attempts *int `json:"attempts"`
	// RetryOn are the provider's HTTP statuses that are retried.
	RetryOn []int `json:"retryOn"`
	// PerTryTimeout bounds each attempt, e.g. 60s; unset, none.
	PerTryTimeout string `json:"perTryTimeout"`
}

// PerMinute caps requests and tokens per minute.
type PerMinute struct {
	RequestsPerMinute int64 `json:"requestsPerMinute"`
	TokensPerMinute   int64 `json:"tokensPerMinute"`
}

func (p PerMinute) set() bool { return p.RequestsPerMinute > 0 || p.TokensPerMinute > 0 }

// Alerts are the thresholds of the latency and error alerts.
type Alerts struct {
	// LatencySeconds: the 95th percentile of a model's request duration.
	LatencySeconds float64 `json:"latencySeconds"`
	// TimeToFirstTokenSeconds: the 95th percentile, streamed requests.
	TimeToFirstTokenSeconds float64 `json:"timeToFirstTokenSeconds"`
	// ErrorRatePercent: failed requests of a model.
	ErrorRatePercent float64 `json:"errorRatePercent"`
	// Disabled: no PrometheusRule.
	Disabled bool `json:"disabled"`
}

// Expose: the gateway outside its location too, over HTTPS at Hostname, on a
// LoadBalancer of its own; the internal endpoint stays as it is.
type Expose struct {
	Enabled                  bool              `json:"enabled"`
	Hostname                 string            `json:"hostname"`
	Issuer                   string            `json:"issuer"`
	Annotations              map[string]string `json:"annotations"`
	LoadBalancerSourceRanges []string          `json:"loadBalancerSourceRanges"`
}

type Client struct {
	Name string `json:"name"`
	// Per-minute caps for this client (requestsPerMinute, tokensPerMinute).
	PerMinute
	// Owner is who to ask about the key (a person or a group).
	Owner string `json:"owner"`
	// MonthlyTokens caps this client's tokens per month (input and output).
	MonthlyTokens int64 `json:"monthlyTokens"`
	// ExpiresAt is the key's last day (YYYY-MM-DD); after it, revoked.
	ExpiresAt string `json:"expiresAt"`
}

// expired: past the client's last day (UTC), its key is revoked.
func (c Client) expired() bool {
	t, err := time.Parse("2006-01-02", c.ExpiresAt)
	return err == nil && !Now().UTC().Before(t.Add(24*time.Hour))
}

type Model struct {
	Name            string     `json:"name"`
	Endpoint        string     `json:"endpoint"`
	Schema          string     `json:"schema"`
	UpstreamModel   string     `json:"upstreamModel"`
	APIKeySecretRef *SecretKey `json:"apiKeySecretRef"`
	// Fallbacks are other models in spec.models to try, in order, when this one fails.
	Fallbacks []string `json:"fallbacks"`
}

type SecretKey struct {
	Name string `json:"name"`
	Key  string `json:"key"`
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

func (s *Spec) replicas() int { return or(s.Replicas, 2) }

func (s *Spec) standbyReplicas() int {
	if s.Recovery.Replicas == nil {
		return 1
	}
	return *s.Recovery.Replicas
}

// activeSite is the serving site; recovery only while there is one.
func (s *Spec) activeSite() string {
	if s.ActiveSite == SiteRecovery && s.Recovery.Enabled {
		return SiteRecovery
	}
	return SiteProtected
}

func (s *Spec) exposed() bool { return s.Expose != nil && s.Expose.Enabled }

// issuer is the cert-manager ClusterIssuer in each location.
func (e *Expose) issuer() string { return or(e.Issuer, "basis") }

// clientList is spec.clients, or the default client apps.
func (s *Spec) clientList() []Client {
	if s.Clients == nil {
		return []Client{{Name: "apps"}}
	}
	return *s.Clients
}

// clients are the names of the clients whose keys are valid.
func (s *Spec) clients() []string {
	var out []string
	for _, c := range s.clientList() {
		if !c.expired() {
			out = append(out, c.Name)
		}
	}
	return out
}

// limited: some client, or the gateway as a whole, has a monthly or per-minute cap.
func (s *Spec) limited() bool {
	if s.MonthlyTokens > 0 || s.RateLimit.set() {
		return true
	}
	for _, c := range s.clientList() {
		if (c.MonthlyTokens > 0 || c.PerMinute.set()) && !c.expired() {
			return true
		}
	}
	return false
}

// attempts per model: spec.retry.attempts, 2 by default.
func (s *Spec) attempts() int {
	if s.Retry == nil || s.Retry.Attempts == nil {
		return 2
	}
	return max(*s.Retry.Attempts, 1)
}

// retryOn are the statuses retried: spec.retry.retryOn, or rate limits and server errors.
func (s *Spec) retryOn() []int {
	if s.Retry != nil && len(s.Retry.RetryOn) > 0 {
		return s.Retry.RetryOn
	}
	return []int{429, 500, 502, 503, 504}
}

// fallbacks are a model's usable fallbacks: other models of the gateway,
// each once, in order.
func (s *Spec) fallbacks(m Model) []string {
	known := map[string]bool{}
	for _, o := range s.Models {
		known[o.Name] = true
	}
	seen := map[string]bool{m.Name: true}
	var out []string
	for _, f := range m.Fallbacks {
		if known[f] && !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

// maxFallbacks is the longest fallback chain of any model.
func (s *Spec) maxFallbacks() int {
	n := 0
	for _, m := range s.Models {
		n = max(n, len(s.fallbacks(m)))
	}
	return n
}

func (a Alerts) latency() float64      { return or(a.LatencySeconds, 60) }
func (a Alerts) firstToken() float64   { return or(a.TimeToFirstTokenSeconds, 10) }
func (a Alerts) errorPercent() float64 { return or(a.ErrorRatePercent, 5) }

func (m *Model) schema() string { return or(m.Schema, "OpenAI") }
