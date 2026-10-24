// Command basis-mcp is the MCP server of an MCPServer (ai.cndev.nl/v1alpha1):
// retrieval and agent memory over a Project's PostgreSQL database, as MCP
// tools (see server/).
//
//	basis-mcp --config /etc/basis-mcp/config.json --keys /etc/basis-mcp/keys
//
// The database and the embeddings endpoint come from the environment:
// DATABASE_URL, and OPENAI_BASE_URL and OPENAI_API_KEY (the Project's
// ModelGateway) when the config names an embeddings model.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bartvanbenthem/basis-ai/mcp/server"
)

// version is set at build time (-ldflags -X main.version=...).
var version = "dev"

func main() {
	var (
		config  = flag.String("config", "/etc/basis-mcp/config.json", "The server's config (the composition's ConfigMap).")
		keys    = flag.String("keys", "/etc/basis-mcp/keys", "Directory with a file per client holding its API key.")
		listen  = flag.String("listen", ":8080", "Address of the MCP endpoint (/mcp) and the health checks.")
		metrics = flag.String("metrics", ":9090", "Address of /metrics.")
		debug   = flag.Bool("debug", false, "Debug logs.")
	)
	flag.Parse()
	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	// Logs on stderr; stdout carries the audit lines alone.
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	if err := run(log, *config, *keys, *listen, *metrics); err != nil {
		log.Error("exiting", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger, configPath, keysDir, listen, metricsAddr string) error {
	cfg, err := server.Load(configPath)
	if err != nil {
		return err
	}
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is not set")
	}
	m := server.NewMetrics()
	embedder := &server.OpenAIEmbedder{BaseURL: os.Getenv("OPENAI_BASE_URL"), APIKey: os.Getenv("OPENAI_API_KEY"),
		Model: cfg.Embeddings.Model, Dimensions: cfg.Embeddings.Dimensions, Observe: m.ObserveEmbedding}
	if cfg.Embeddings.Model != "" && embedder.BaseURL == "" {
		return fmt.Errorf("embeddings model %s needs OPENAI_BASE_URL", cfg.Embeddings.Model)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	store, err := server.NewStore(ctx, dbURL, cfg, embedder)
	if err != nil {
		return err
	}
	defer store.Close()
	k, err := server.NewKeys(keysDir)
	if err != nil {
		return fmt.Errorf("keys: %w", err)
	}
	go k.Watch(ctx, 15*time.Second, func(err error) { log.Warn("reading keys", "error", err) })
	go server.Maintain(ctx, store, m, log)

	tools := server.NewTools(cfg, store, m, server.NewAudit(os.Stdout, cfg.Server), version)
	api := &http.Server{Addr: listen, Handler: server.Handler(tools, k, store.Problem, log), ReadHeaderTimeout: 10 * time.Second}
	mon := &http.Server{Addr: metricsAddr, Handler: server.MetricsHandler(m), ReadHeaderTimeout: 10 * time.Second}
	errs := make(chan error, 2)
	for _, s := range []*http.Server{api, mon} {
		go func() {
			if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errs <- err
			}
		}()
	}
	log.Info("serving", "server", cfg.Server, "namespace", cfg.Namespace, "site", cfg.Site, "tools", cfg.Tools(),
		"clients", k.Len(), "version", version)

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = mon.Shutdown(shutdown) //nolint:errcheck // exiting anyway
	return api.Shutdown(shutdown)
}
