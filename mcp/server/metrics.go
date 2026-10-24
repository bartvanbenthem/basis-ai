package server

import (
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Metrics are the server's, scraped by the Project's Prometheus (the
// MCPServer's PodMonitor): calls per tool, client and outcome, their
// duration, the embedding calls and whether the database is ready.
type Metrics struct {
	Registry   *prometheus.Registry
	calls      *prometheus.CounterVec
	duration   *prometheus.HistogramVec
	results    *prometheus.HistogramVec
	embeddings *prometheus.CounterVec
	embedTime  prometheus.Histogram
	ready      prometheus.Gauge
	backfilled prometheus.Counter
	expired    prometheus.Counter
}

func NewMetrics() *Metrics {
	m := &Metrics{
		Registry: prometheus.NewRegistry(),
		calls: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "basis_mcp_tool_calls_total", Help: "Tool calls by tool, client and outcome (ok, error).",
		}, []string{"tool", "client", "outcome"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "basis_mcp_tool_duration_seconds", Help: "How long tool calls take.",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}, []string{"tool"}),
		results: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "basis_mcp_tool_results", Help: "Hits a search or recall returns.",
			Buckets: []float64{0, 1, 2, 4, 8, 16, 32, 50},
		}, []string{"tool"}),
		embeddings: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "basis_mcp_embedding_requests_total", Help: "Calls to the embeddings model by outcome.",
		}, []string{"outcome"}),
		embedTime: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "basis_mcp_embedding_duration_seconds", Help: "How long the embeddings model takes.",
			Buckets: []float64{.01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}),
		ready: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "basis_mcp_database_ready", Help: "1 when the database and its tables are ready.",
		}),
		backfilled: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "basis_mcp_backfilled_embeddings_total", Help: "Rows embedded after they were stored.",
		}),
		expired: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "basis_mcp_expired_memories_total", Help: "Memories deleted past memory.retentionDays.",
		}),
	}
	m.Registry.MustRegister(m.calls, m.duration, m.results, m.embeddings, m.embedTime, m.ready, m.backfilled, m.expired,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return m
}

// ObserveEmbedding is the embedder's Observe.
func (m *Metrics) ObserveEmbedding(outcome string, d time.Duration) {
	m.embeddings.WithLabelValues(outcome).Inc()
	m.embedTime.Observe(d.Seconds())
}

// Audit writes one JSON line per tool call: who called which tool and how
// it went, never the query or the content. The portal's audit trail reads
// these lines (field basis: mcp) from the pods' logs.
type Audit struct {
	mu     sync.Mutex
	w      io.Writer
	server string
}

func NewAudit(w io.Writer, server string) *Audit { return &Audit{w: w, server: server} }

// AuditRecord is one line.
type AuditRecord struct {
	Basis      string `json:"basis"`
	Time       string `json:"time"`
	Server     string `json:"server"`
	Client     string `json:"client"`
	Tool       string `json:"tool"`
	Outcome    string `json:"outcome"`
	DurationMS int64  `json:"duration_ms"`
	// Results: hits returned, or rows changed.
	Results *int `json:"results,omitempty"`
	// ID: the document or memory a call wrote, read or removed.
	ID    string `json:"id,omitempty"`
	Error string `json:"error,omitempty"`
}

func (a *Audit) write(r AuditRecord) {
	r.Basis, r.Server = "mcp", a.server
	raw, _ := json.Marshal(r)
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _ = a.w.Write(append(raw, '\n')) //nolint:errcheck // stdout
}
