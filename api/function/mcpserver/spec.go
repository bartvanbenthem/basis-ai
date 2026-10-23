package mcpserver

import "time"

// The MCPServer XR, as far as the composition reads it. Fields mirror
// apis/mcpserver/definition.yaml; the accessors repeat the XRD defaults so
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
	Database struct {
		Stack                string     `json:"stack"`
		Cluster              string     `json:"cluster"`
		Name                 string     `json:"name"`
		CredentialsSecretRef *SecretRef `json:"credentialsSecretRef"`
	} `json:"database"`
	Embeddings struct {
		Model      string `json:"model"`
		Dimensions int    `json:"dimensions"`
		Gateway    string `json:"gateway"`
		Client     string `json:"client"`
	} `json:"embeddings"`
	Retrieval struct {
		Enabled *bool  `json:"enabled"`
		Table   string `json:"table"`
		Columns struct {
			ID        string `json:"id"`
			Content   string `json:"content"`
			Title     string `json:"title"`
			Source    string `json:"source"`
			Metadata  string `json:"metadata"`
			Embedding string `json:"embedding"`
		} `json:"columns"`
		Mode             string `json:"mode"`
		TopK             int    `json:"topK"`
		TextSearchConfig string `json:"textSearchConfig"`
		Ingest           bool   `json:"ingest"`
	} `json:"retrieval"`
	Memory struct {
		Enabled       *bool  `json:"enabled"`
		Scope         string `json:"scope"`
		RetentionDays int    `json:"retentionDays"`
	} `json:"memory"`
	Clients   *[]Client `json:"clients"`
	Replicas  int       `json:"replicas"`
	Resources struct {
		CPU    string `json:"cpu"`
		Memory string `json:"memory"`
	} `json:"resources"`
	Recovery struct {
		Enabled  bool `json:"enabled"`
		Replicas *int `json:"replicas"`
	} `json:"recovery"`
	Image  string `json:"image"`
	Alerts Alerts `json:"alerts"`
}

type SecretRef struct {
	Name string `json:"name"`
}

type Client struct {
	Name      string   `json:"name"`
	Owner     string   `json:"owner"`
	Tools     []string `json:"tools"`
	ExpiresAt string   `json:"expiresAt"`
}

// Alerts are the thresholds of the server's alerts.
type Alerts struct {
	ErrorRatePercent float64 `json:"errorRatePercent"`
	LatencySeconds   float64 `json:"latencySeconds"`
	Disabled         bool    `json:"disabled"`
}

// Sites of a Project (spec.locations).
const (
	SiteProtected = "protected"
	SiteRecovery  = "recovery"
)

// Now is the composition's clock (client expiry); tests replace it.
var Now = time.Now

func or[T comparable](v, def T) T {
	var zero T
	if v == zero {
		return def
	}
	return v
}

func orTrue(b *bool) bool { return b == nil || *b }

func (s *Spec) replicas() int { return or(s.Replicas, 2) }

func (s *Spec) standbyReplicas() int {
	if s.Recovery.Replicas == nil {
		return 1
	}
	return *s.Recovery.Replicas
}

func (s *Spec) retrieval() bool     { return orTrue(s.Retrieval.Enabled) }
func (s *Spec) memory() bool        { return orTrue(s.Memory.Enabled) }
func (s *Spec) embeds() bool        { return s.Embeddings.Model != "" }
func (s *Spec) cpu() string         { return or(s.Resources.CPU, "250m") }
func (s *Spec) memoryLimit() string { return or(s.Resources.Memory, "256Mi") }
func (s *Spec) databaseName() string {
	return or(s.Database.Name, "app")
}

// mode is the search mode: hybrid with a model, text without.
func (s *Spec) mode() string {
	if s.Retrieval.Mode != "" {
		return s.Retrieval.Mode
	}
	if s.embeds() {
		return "hybrid"
	}
	return "text"
}

// embeddingsClient is the server's client at embeddings.gateway.
func (s *Spec) embeddingsClient(name string) string { return or(s.Embeddings.Client, name) }

// clientList is spec.clients, the XRD's default when unset.
func (s *Spec) clientList() []Client {
	if s.Clients == nil {
		return []Client{{Name: "agents"}}
	}
	return *s.Clients
}

// expired: the client's key is past its last day (expiresAt, UTC).
func (c Client) expired() bool {
	if c.ExpiresAt == "" {
		return false
	}
	last, err := time.Parse("2006-01-02", c.ExpiresAt)
	if err != nil {
		return false
	}
	return !Now().UTC().Before(last.AddDate(0, 0, 1))
}

func (a Alerts) errorRate() float64 { return or(a.ErrorRatePercent, 5) }
func (a Alerts) latency() float64   { return or(a.LatencySeconds, 2) }
