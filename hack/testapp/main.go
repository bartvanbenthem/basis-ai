// Command testapp is BASIS Lens: a photo library you search by meaning, on
// one GenAIStack, to show and test the whole stack the way a team would use
// it. A vision model captions and tags every photo and a multimodal model
// embeds it (both through the stack's ModelGateway); the photos and their
// embeddings live in the stack's PostgreSQL (pgvector + full-text search),
// and the stack's Valkey caches query embeddings, search results (exact and
// semantic) and answers about photos.
//
// Configuration is the stack's connection Secret (envFrom), plus:
//
//	VISION_MODEL           qwen3-vl            a vision chat model on the gateway
//	EMBED_MODEL            qwen3-vl-embedding  a multimodal embedding model on the gateway
//	EMBED_DIM              1024                its (Matryoshka) dimensions, at most 2000
//	RESULTS                24                  photos per search
//	CACHE_TTL              1h
//	SEMANTIC_MAX_DISTANCE  0.25                cosine distance for a semantic hit (paraphrased
//	                                           searches measure 0.12-0.21, other searches 0.35+)
//	MIN_SIMILARITY         0.07                cosine similarity a vector match needs (text to image:
//	                                           matches 0.09-0.2, unrelated photos below 0.06)
//	SEED_COUNT             48                  sample photos the "Load samples" button adds
//	OPENAI_CA_FILE                             extra CA for the gateway (outside the cluster)
//	LISTEN                 :8080
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed web
var web embed.FS

// maxUpload is the largest photo the app takes (a phone's full-size JPEG fits).
const maxUpload = 25 << 20

type config struct {
	databaseURL, valkeyHost, valkeyPort, valkeyPassword string
	valkeyCluster                                       bool
	gatewayURL, gatewayKey, caFile                      string
	visionModel, embedModel                             string
	dim, results, seedCount                             int
	site, listen                                        string
	cacheTTL                                            time.Duration
	maxDistance, minSimilarity                          float64
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadConfig() (config, error) {
	c := config{
		databaseURL:    os.Getenv("DATABASE_URL"),
		valkeyHost:     os.Getenv("VALKEY_HOST"),
		valkeyPort:     env("VALKEY_PORT", "6379"),
		valkeyPassword: os.Getenv("VALKEY_PASSWORD"),
		valkeyCluster:  os.Getenv("VALKEY_CLUSTER") == "true",
		gatewayURL:     os.Getenv("OPENAI_BASE_URL"),
		gatewayKey:     os.Getenv("OPENAI_API_KEY"),
		caFile:         os.Getenv("OPENAI_CA_FILE"),
		visionModel:    env("VISION_MODEL", "qwen3-vl"),
		embedModel:     env("EMBED_MODEL", "qwen3-vl-embedding"),
		site:           env("SITE", "local"),
		listen:         env("LISTEN", ":8080"),
	}
	ints := map[string]*int{"EMBED_DIM": &c.dim, "RESULTS": &c.results, "SEED_COUNT": &c.seedCount}
	defaults := map[string]string{"EMBED_DIM": "1024", "RESULTS": "24", "SEED_COUNT": "48"}
	for k, p := range ints {
		v, err := strconv.Atoi(env(k, defaults[k]))
		if err != nil || v < 1 {
			return c, fmt.Errorf("%s: a positive number", k)
		}
		*p = v
	}
	if c.dim > 2000 {
		return c, errors.New("EMBED_DIM: at most 2000 (pgvector's HNSW limit)")
	}
	var err error
	if c.cacheTTL, err = time.ParseDuration(env("CACHE_TTL", "1h")); err != nil {
		return c, fmt.Errorf("CACHE_TTL: %w", err)
	}
	if c.maxDistance, err = strconv.ParseFloat(env("SEMANTIC_MAX_DISTANCE", "0.25"), 64); err != nil {
		return c, fmt.Errorf("SEMANTIC_MAX_DISTANCE: %w", err)
	}
	if c.minSimilarity, err = strconv.ParseFloat(env("MIN_SIMILARITY", "0.07"), 64); err != nil {
		return c, fmt.Errorf("MIN_SIMILARITY: %w", err)
	}
	var missing []string
	for k, v := range map[string]string{"DATABASE_URL": c.databaseURL, "OPENAI_BASE_URL": c.gatewayURL, "OPENAI_API_KEY": c.gatewayKey} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return c, fmt.Errorf("missing %s: mount the stack's connection Secret", strings.Join(missing, ", "))
	}
	return c, nil
}

func httpClient(caFile string, timeout time.Duration) (*http.Client, error) {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("%s: no certificates", caFile)
		}
		tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	return &http.Client{Transport: tr, Timeout: timeout}, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("exiting", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	gw, err := httpClient(cfg.caFile, 3*time.Minute)
	if err != nil {
		return err
	}
	fetch, _ := httpClient("", time.Minute)
	store, err := NewStore(ctx, cfg.databaseURL, cfg.dim, cfg.minSimilarity)
	if err != nil {
		return err
	}
	l := &Lens{store: store, site: cfg.site, limit: cfg.results, metrics: NewMetrics(), http: fetch,
		llm: &LLM{base: cfg.gatewayURL, key: cfg.gatewayKey, visionModel: cfg.visionModel, embedModel: cfg.embedModel, dim: cfg.dim, http: gw}}
	cacheErr := "VALKEY_HOST not set"
	if cfg.valkeyHost != "" {
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		l.cache, err = NewCache(cctx, net.JoinHostPort(cfg.valkeyHost, cfg.valkeyPort), cfg.valkeyPassword, cfg.valkeyCluster,
			cfg.dim, cfg.cacheTTL, cfg.maxDistance)
		cancel()
		if err != nil {
			// Search without a cache rather than not at all.
			cacheErr = err.Error()
			slog.Warn("no cache", "err", err)
		} else if l.cache.Err != "" {
			slog.Warn(l.cache.Err)
		}
	}

	srv := &http.Server{Addr: cfg.listen, Handler: logRequests(routes(l, store, cfg, cacheErr)), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	slog.Info("listening", "addr", cfg.listen, "site", cfg.site, "vision", cfg.visionModel, "embed", cfg.embedModel)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func routes(l *Lens, store *Store, cfg config, cacheErr string) *http.ServeMux {
	mux := http.NewServeMux()
	static, _ := fs.Sub(web, "web")
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := store.db.Ping(r.Context()); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		l.metrics.Write(w)
	})
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, status(r.Context(), l, cfg, cacheErr))
	})

	mux.HandleFunc("GET /api/photos", func(w http.ResponseWriter, r *http.Request) {
		photos, err := store.Latest(r.Context(), 200)
		if errors.Is(err, errNoSchema) {
			photos, err = []Photo{}, nil
		}
		reply(w, photos, err)
	})
	mux.HandleFunc("POST /api/photos", func(w http.ResponseWriter, r *http.Request) {
		raw, err := upload(w, r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		res, err := l.Add(r.Context(), raw, r.FormValue("author"), "")
		if errors.Is(err, errReadOnly) {
			writeError(w, http.StatusConflict, err)
			return
		}
		reply(w, res, err)
	})
	mux.HandleFunc("GET /api/photos/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if ok {
			p, err := store.Get(r.Context(), id)
			reply(w, p, err)
		}
	})
	mux.HandleFunc("DELETE /api/photos/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		found, err := store.Delete(r.Context(), id)
		if err == nil && !found {
			err = pgx.ErrNoRows
		}
		reply(w, map[string]bool{"deleted": found}, err)
	})
	mux.HandleFunc("GET /api/photos/{id}/similar", func(w http.ResponseWriter, r *http.Request) {
		if id, ok := pathID(w, r); ok {
			res, err := l.Similar(r.Context(), id)
			reply(w, res, err)
		}
	})
	mux.HandleFunc("POST /api/photos/{id}/ask", func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		var req struct {
			Question string `json:"question"`
			NoCache  bool   `json:"noCache"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Question) == "" || len(req.Question) > 1000 {
			writeError(w, http.StatusBadRequest, errors.New(`send {"question": "..."}, up to 1000 characters`))
			return
		}
		res, err := l.Ask(r.Context(), id, strings.TrimSpace(req.Question), req.NoCache)
		reply(w, res, err)
	})
	for _, size := range []string{"image", "thumb"} {
		mux.HandleFunc("GET /img/{id}/"+size, func(w http.ResponseWriter, r *http.Request) {
			id, ok := pathID(w, r)
			if !ok {
				return
			}
			b, err := store.Image(r.Context(), id, size == "thumb")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			// A photo never changes under its id.
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			_, _ = w.Write(b)
		})
	}

	mux.HandleFunc("GET /api/search", func(w http.ResponseWriter, r *http.Request) {
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if q == "" || len(q) > 500 {
			writeError(w, http.StatusBadRequest, errors.New("q: what to look for, up to 500 characters"))
			return
		}
		res, err := l.Search(r.Context(), q, r.URL.Query().Get("nocache") == "1")
		reply(w, res, err)
	})
	mux.HandleFunc("POST /api/search/image", func(w http.ResponseWriter, r *http.Request) {
		raw, err := upload(w, r)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		res, err := l.SearchImage(r.Context(), raw)
		reply(w, res, err)
	})
	mux.HandleFunc("GET /api/searches", func(w http.ResponseWriter, r *http.Request) {
		s, err := store.Searches(r.Context(), 12)
		if err != nil {
			s = []SearchLog{}
		}
		writeJSON(w, http.StatusOK, s)
	})
	mux.HandleFunc("POST /api/seed", func(w http.ResponseWriter, r *http.Request) {
		if ro, err := store.ReadOnly(r.Context()); err != nil || ro {
			writeError(w, http.StatusConflict, errReadOnly)
			return
		}
		if err := l.Seed(cfg.seedCount); err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusAccepted, l.SeedStatus())
	})
	return mux
}

// upload reads the photo of a multipart form (field "photo"), in memory:
// the root filesystem is read-only.
func upload(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, errors.New("send the photo as multipart/form-data, field photo")
	}
	for {
		part, err := mr.NextPart()
		if err != nil {
			return nil, errors.New("no photo field (or larger than 25MiB)")
		}
		switch part.FormName() {
		case "author":
			v, _ := io.ReadAll(io.LimitReader(part, 200))
			r.Form = map[string][]string{"author": {strings.TrimSpace(string(v))}}
		case "photo":
			raw, err := io.ReadAll(io.LimitReader(part, maxUpload+1))
			if err != nil || len(raw) > maxUpload {
				return nil, errors.New("photo larger than 25MiB")
			}
			return raw, nil
		}
	}
}

type component struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

func status(ctx context.Context, l *Lens, cfg config, cacheErr string) map[string]any {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out := map[string]any{"site": cfg.site, "active": os.Getenv("ACTIVE") != "false",
		"visionModel": cfg.visionModel, "embedModel": cfg.embedModel, "dim": cfg.dim, "seed": l.SeedStatus()}

	db := component{OK: true}
	if ro, err := l.store.ReadOnly(ctx); err != nil {
		db = component{Detail: err.Error()}
	} else {
		db.Detail = "primary (read-write)"
		if ro {
			db.Detail = "replica (read-only)"
		}
		out["readOnly"] = ro
		if st, err := l.store.Stats(ctx); err == nil {
			out["library"] = st
		}
	}
	out["database"] = db

	switch {
	case l.cache == nil:
		out["cache"] = component{Detail: cacheErr}
	default:
		if err := l.cache.Ping(ctx); err != nil {
			out["cache"] = component{Detail: err.Error()}
		} else if l.cache.Semantic {
			out["cache"] = component{OK: true, Detail: fmt.Sprintf("exact + semantic (cosine distance ≤ %g)", cfg.maxDistance)}
		} else {
			out["cache"] = component{OK: true, Detail: "exact only; " + l.cache.Err}
		}
	}

	if err := l.llm.Ping(ctx); err != nil {
		out["gateway"] = component{Detail: err.Error()}
	} else {
		out["gateway"] = component{OK: true, Detail: strings.TrimSuffix(cfg.gatewayURL, "/v1")}
	}
	return out
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return 0, false
	}
	return id, true
}

// reply writes v, or the error with a status that fits it.
func reply(w http.ResponseWriter, v any, err error) {
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, v)
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, errors.New("no such photo"))
	case errors.Is(err, errNoSchema), errors.Is(err, errReadOnly):
		writeError(w, http.StatusConflict, err)
	default:
		slog.Error("request", "err", err)
		writeError(w, http.StatusBadGateway, err)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			slog.Info("request", "method", r.Method, "path", r.URL.Path, "ms", time.Since(start).Milliseconds())
		}
	})
}
