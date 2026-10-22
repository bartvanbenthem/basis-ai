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

// limited: some client, or the gateway as a whole, has a monthly token cap.
func (s *Spec) limited() bool {
	if s.MonthlyTokens > 0 {
		return true
	}
	for _, c := range s.clientList() {
		if c.MonthlyTokens > 0 && !c.expired() {
			return true
		}
	}
	return false
}

func (m *Model) schema() string { return or(m.Schema, "OpenAI") }
