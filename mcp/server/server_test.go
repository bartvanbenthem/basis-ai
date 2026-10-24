package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// fakeBackend records what the tools ask of the store.
type fakeBackend struct {
	mu       sync.Mutex
	problem  string
	recalled []string // clients
	remember []string // client: content
}

func (f *fakeBackend) Problem() string { return f.problem }
func (f *fakeBackend) Search(_ context.Context, q string, k int, _ map[string]any) ([]Document, string, error) {
	return []Document{{ID: "1", Title: "Refunds", Content: "within " + q, Score: float64(k)}}, "", nil
}
func (f *fakeBackend) Fetch(_ context.Context, id string) (*Document, error) {
	if id != "1" {
		return nil, nil
	}
	return &Document{ID: "1", Content: "all of it"}, nil
}
func (f *fakeBackend) AddDocument(context.Context, Document) (string, bool, error) {
	return "7", true, nil
}
func (f *fakeBackend) DeleteDocument(context.Context, string) (bool, error) { return true, nil }
func (f *fakeBackend) Remember(_ context.Context, client, content string, _ []string) (int64, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.remember = append(f.remember, client+": "+content)
	return 3, true, nil
}
func (f *fakeBackend) Recall(_ context.Context, client, _ string, _ int, _ []string) ([]MemoryItem, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recalled = append(f.recalled, client)
	return []MemoryItem{{ID: 3, Content: "remembered"}}, "", nil
}
func (f *fakeBackend) Forget(context.Context, string, int64) (bool, error) { return true, nil }

// bearer adds a key to every request.
type bearer struct{ key string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.key)
	return http.DefaultTransport.RoundTrip(r)
}

type testServer struct {
	url     string
	backend *fakeBackend
	audit   *bytes.Buffer
	metrics *Metrics
	keysDir string
	keys    *Keys
}

func startServer(t *testing.T, cfg *Config) *testServer {
	t.Helper()
	cfg.defaults()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for client, key := range map[string]string{"agent": "key-agent", "reader": "key-reader"} {
		if err := os.WriteFile(filepath.Join(dir, client), []byte(key+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A Secret volume's bookkeeping entries.
	_ = os.Mkdir(filepath.Join(dir, "..data"), 0o700)
	keys, err := NewKeys(dir)
	if err != nil {
		t.Fatal(err)
	}
	ts := &testServer{backend: &fakeBackend{}, audit: &bytes.Buffer{}, metrics: NewMetrics(), keysDir: dir, keys: keys}
	tools := NewTools(cfg, ts.backend, ts.metrics, NewAudit(ts.audit, cfg.Server), "test")
	srv := httptest.NewServer(Handler(tools, keys, ts.backend.Problem, nil))
	t.Cleanup(srv.Close)
	ts.url = srv.URL
	return ts
}

func (ts *testServer) connect(t *testing.T, key string) (*mcp.ClientSession, error) {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	return client.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint: ts.url + Path, HTTPClient: &http.Client{Transport: bearer{key}}, MaxRetries: -1, DisableStandaloneSSE: true,
	}, nil)
}

func toolNames(t *testing.T, s *mcp.ClientSession) []string {
	t.Helper()
	res, err := s.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
	}
	// The SDK lists them by name.
	slices.Sort(names)
	return names
}

func fullConfig() *Config {
	return &Config{Server: "kb", Namespace: "demo",
		Retrieval:  Retrieval{Enabled: true, Ingest: true},
		Memory:     Memory{Enabled: true},
		Embeddings: Embeddings{Model: "m"},
		Clients:    map[string]Client{"agent": {}, "reader": {Tools: []string{ToolSearch, ToolFetch, ToolRemember}}}}
}

func TestToolsPerClient(t *testing.T) {
	ts := startServer(t, fullConfig())
	agent, err := ts.connect(t, "key-agent")
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	all := slices.Sorted(slices.Values(AllTools))
	if got := toolNames(t, agent); !slices.Equal(got, all) {
		t.Fatalf("agent's tools %v, want %v", got, all)
	}
	reader, err := ts.connect(t, "key-reader")
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if got := toolNames(t, reader); !slices.Equal(got, []string{ToolFetch, ToolRemember, ToolSearch}) {
		t.Fatalf("reader's tools %v", got)
	}
	// A tool it may not call doesn't exist for it.
	res, err := reader.CallTool(context.Background(), &mcp.CallToolParams{Name: ToolForget, Arguments: map[string]any{"id": 3}})
	if err == nil && (res == nil || !res.IsError) {
		t.Fatalf("reader called forget: %+v", res)
	}
	if !strings.Contains(agent.InitializeResult().Instructions, "Recall memories") {
		t.Fatalf("instructions: %q", agent.InitializeResult().Instructions)
	}
}

func TestToolCalls(t *testing.T) {
	ts := startServer(t, fullConfig())
	s, err := ts.connect(t, "key-agent")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	res, err := s.CallTool(ctx, &mcp.CallToolParams{Name: ToolSearch, Arguments: map[string]any{"query": "refund", "limit": 500}})
	if err != nil || res.IsError {
		t.Fatalf("search: %v %+v", err, res)
	}
	var out SearchOut
	raw, _ := json.Marshal(res.StructuredContent)
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Results) != 1 || out.Results[0].Score != maxLimit {
		t.Fatalf("search output %s: %v (limit clamped to %d)", raw, err, maxLimit)
	}

	// Memory is the calling client's: the tool passes who called.
	if res, err := s.CallTool(ctx, &mcp.CallToolParams{Name: ToolRemember, Arguments: map[string]any{"content": "prefers euros", "tags": []string{"pref"}}}); err != nil || res.IsError {
		t.Fatalf("remember: %v %+v", err, res)
	}
	if res, err := s.CallTool(ctx, &mcp.CallToolParams{Name: ToolRecall, Arguments: map[string]any{"query": "currency"}}); err != nil || res.IsError {
		t.Fatalf("recall: %v %+v", err, res)
	}
	if !slices.Equal(ts.backend.remember, []string{"agent: prefers euros"}) || !slices.Equal(ts.backend.recalled, []string{"agent"}) {
		t.Fatalf("backend saw %v / %v", ts.backend.remember, ts.backend.recalled)
	}

	// Tool errors are results the model sees, not protocol errors.
	res, err = s.CallTool(ctx, &mcp.CallToolParams{Name: ToolFetch, Arguments: map[string]any{"id": "9"}})
	if err != nil || !res.IsError {
		t.Fatalf("fetch of a missing document: %v %+v", err, res)
	}
	res, err = s.CallTool(ctx, &mcp.CallToolParams{Name: ToolSearch, Arguments: map[string]any{"query": "  "}})
	if err != nil || !res.IsError {
		t.Fatalf("empty query: %v %+v", err, res)
	}

	// One audit line per call, without the query or the content.
	lines := strings.Split(strings.TrimSpace(ts.audit.String()), "\n")
	if len(lines) != 5 {
		t.Fatalf("%d audit lines:\n%s", len(lines), ts.audit.String())
	}
	var first AuditRecord
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if first.Basis != "mcp" || first.Server != "kb" || first.Client != "agent" || first.Tool != ToolSearch ||
		first.Outcome != "ok" || first.Results == nil || *first.Results != 1 || first.Time == "" {
		t.Fatalf("audit line %+v", first)
	}
	if strings.Contains(ts.audit.String(), "refund") || strings.Contains(ts.audit.String(), "euros") {
		t.Fatalf("the audit log carries a query or content:\n%s", ts.audit.String())
	}
	if !strings.Contains(lines[3], `"outcome":"error"`) || !strings.Contains(lines[3], `"id":"9"`) {
		t.Fatalf("failed fetch's audit line: %s", lines[3])
	}
	if n := testutil.ToFloat64(ts.metrics.calls.WithLabelValues(ToolSearch, "agent", "error")); n != 1 {
		t.Fatalf("search errors counted %v", n)
	}
	if n := testutil.ToFloat64(ts.metrics.calls.WithLabelValues(ToolRemember, "agent", "ok")); n != 1 {
		t.Fatalf("remember calls counted %v", n)
	}
}

func TestNotReady(t *testing.T) {
	ts := startServer(t, fullConfig())
	ts.backend.problem = "can't reach the database"
	s, err := ts.connect(t, "key-agent")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: ToolRecall, Arguments: map[string]any{}})
	if err != nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "isn't ready: can't reach the database") {
		t.Fatalf("call while not ready: %v %+v", err, res)
	}
	resp, err := http.Get(ts.url + "/readyz")
	if err != nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("readyz: %v %v", resp.StatusCode, err)
	}
}

func TestAuth(t *testing.T) {
	ts := startServer(t, fullConfig())
	for _, key := range []string{"", "wrong", "key-agen"} {
		if s, err := ts.connect(t, key); err == nil {
			s.Close()
			t.Fatalf("connected with key %q", key)
		}
	}
	req, _ := http.NewRequest(http.MethodPost, ts.url+Path, strings.NewReader(`{}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no key: %v %v", resp.StatusCode, err)
	}
	resp, _ = http.Get(ts.url + "/healthz")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz needs no key: %d", resp.StatusCode)
	}

	// A revoked key stops working once the keys are read again.
	if err := os.Remove(filepath.Join(ts.keysDir, "reader")); err != nil {
		t.Fatal(err)
	}
	if err := ts.keys.reload(); err != nil {
		t.Fatal(err)
	}
	if s, err := ts.connect(t, "key-reader"); err == nil {
		s.Close()
		t.Fatal("connected with a revoked key")
	}
	if ts.keys.Len() != 1 {
		t.Fatalf("%d keys after revoking one", ts.keys.Len())
	}
}

func TestUnlistedClientHasNoTools(t *testing.T) {
	cfg := fullConfig()
	delete(cfg.Clients, "reader")
	ts := startServer(t, cfg)
	s, err := ts.connect(t, "key-reader")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if got := toolNames(t, s); len(got) != 0 {
		t.Fatalf("a client the config doesn't list has tools %v", got)
	}
}

func TestMetricsEndpoint(t *testing.T) {
	m := NewMetrics()
	m.ObserveEmbedding("ok", 0)
	srv := httptest.NewServer(MetricsHandler(m))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	_, _ = b.ReadFrom(resp.Body)
	for _, want := range []string{`basis_mcp_embedding_requests_total{outcome="ok"} 1`, "basis_mcp_database_ready 0"} {
		if !strings.Contains(b.String(), want) {
			t.Fatalf("/metrics lacks %q", want)
		}
	}
}
