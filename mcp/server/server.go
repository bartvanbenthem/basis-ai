package server

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Path the MCP endpoint is served at.
const Path = "/mcp"

// Handler serves /mcp to clients with a key (Authorization: Bearer <key>),
// each with an MCP server of its own tools, plus /healthz and /readyz.
// Stateless: any replica answers any request, no session affinity needed.
func Handler(tools *Tools, keys *Keys, ready func() string, log *slog.Logger) http.Handler {
	var servers sync.Map // client -> *mcp.Server
	streamable := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		info := auth.TokenInfoFromContext(r.Context())
		if info == nil || info.UserID == "" {
			return nil
		}
		if s, ok := servers.Load(info.UserID); ok {
			return s.(*mcp.Server)
		}
		s, _ := servers.LoadOrStore(info.UserID, tools.Server(info.UserID))
		return s.(*mcp.Server)
	}, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, Logger: log})

	mux := http.NewServeMux()
	// Keys don't expire by themselves: the composition revokes them.
	mux.Handle(Path, auth.RequireBearerToken(keys.Verifier(), &auth.RequireBearerTokenOptions{AllowMissingExpiration: true})(streamable))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if p := ready(); p != "" {
			http.Error(w, p, http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok")) //nolint:errcheck // health check
	})
	return mux
}

// MetricsHandler serves /metrics.
func MetricsHandler(m *Metrics) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{}))
	return mux
}

// Maintain keeps the store ready until ctx ends: prepares it until that
// works (and again when the database stops answering), embeds what was
// stored without an embedding, and expires old memories.
func Maintain(ctx context.Context, store *Store, m *Metrics, log *slog.Logger) {
	prepare := time.NewTicker(10 * time.Second)
	backfill := time.NewTicker(30 * time.Second)
	expire := time.NewTicker(time.Hour)
	defer prepare.Stop()
	defer backfill.Stop()
	defer expire.Stop()
	last := "not prepared yet"
	tryPrepare := func() {
		err := store.Prepare(ctx)
		problem := ""
		if err != nil {
			problem = err.Error()
		}
		if problem != last {
			if problem != "" {
				log.Warn("not ready", "problem", problem)
			} else {
				log.Info("ready", "dims", store.Dims())
			}
			last = problem
		}
		if problem == "" {
			m.ready.Set(1)
		} else {
			m.ready.Set(0)
		}
	}
	tryPrepare()
	for {
		select {
		case <-ctx.Done():
			return
		case <-prepare.C:
			if store.Problem() != "" || store.Ping(ctx) != nil {
				tryPrepare()
			}
		case <-backfill.C:
			if store.Problem() != "" {
				continue
			}
			n, err := store.Backfill(ctx, 64)
			if err != nil {
				log.Warn("backfilling embeddings", "error", err)
			}
			if n > 0 {
				m.backfilled.Add(float64(n))
				log.Info("backfilled embeddings", "rows", n)
			}
		case <-expire.C:
			if store.Problem() != "" {
				continue
			}
			n, err := store.Expire(ctx)
			if err != nil {
				log.Warn("expiring memories", "error", err)
			}
			if n > 0 {
				m.expired.Add(float64(n))
				log.Info("expired memories", "rows", n)
			}
		}
	}
}
