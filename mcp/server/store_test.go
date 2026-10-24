package server

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// The store's tests run against a real PostgreSQL with pgvector:
//
//	podman run -d -p 55432:5432 -e POSTGRES_USER=app -e POSTGRES_PASSWORD=test pgvector/pgvector:pg18
//	BASIS_MCP_TEST_DATABASE_URL=postgres://app:test@127.0.0.1:55432/app go test ./...
//
// Without the variable they're skipped.

// wordEmbedder is a deterministic stand-in for a model: hashed bag of
// words, normalized, so texts sharing words are close.
type wordEmbedder struct {
	dims  int
	fail  atomic.Bool
	calls atomic.Int64
}

func (e *wordEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	e.calls.Add(1)
	if e.fail.Load() {
		return nil, errors.New("model down")
	}
	out := make([][]float32, len(texts))
	for i, text := range texts {
		v := make([]float32, e.dims)
		for _, w := range strings.Fields(strings.ToLower(text)) {
			h := fnv.New32a()
			h.Write([]byte(strings.Trim(w, ".,:;!?")))
			v[h.Sum32()%uint32(e.dims)]++
		}
		var norm float64
		for _, f := range v {
			norm += float64(f * f)
		}
		if norm == 0 {
			v[0], norm = 1, 1
		}
		for j := range v {
			v[j] /= float32(math.Sqrt(norm))
		}
		out[i] = v
	}
	return out, nil
}

func testURL(t *testing.T) string {
	url := os.Getenv("BASIS_MCP_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("BASIS_MCP_TEST_DATABASE_URL not set")
	}
	return url
}

// newTestStore prepares a store whose tables live in a schema of its own,
// dropped after the test.
func newTestStore(t *testing.T, edit func(*Config), embed Embedder) *Store {
	t.Helper()
	url := testURL(t)
	schema := "t_" + strings.ToLower(strings.NewReplacer("/", "_", "-", "_").Replace(t.Name()))
	cfg := &Config{Server: "kb", Namespace: "demo",
		Retrieval:  Retrieval{Enabled: true, Table: schema + ".documents"},
		Memory:     Memory{Enabled: true, Table: schema + ".memories"},
		Embeddings: Embeddings{Model: "words"},
		Clients:    map[string]Client{"agent-a": {}, "agent-b": {}}}
	if edit != nil {
		edit(cfg)
	}
	if cfg.Retrieval.Table == schema+".documents" {
		cfg.Retrieval.Own = true
	}
	cfg.defaults()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	s, err := NewStore(ctx, url, cfg, embed)
	if err != nil {
		t.Fatal(err)
	}
	drop := func() { _, _ = s.pool.Exec(ctx, "DROP SCHEMA IF EXISTS "+quote(schema)+" CASCADE") }
	drop()
	t.Cleanup(func() { drop(); s.Close() })
	return s
}

func mustPrepare(t *testing.T, s *Store) {
	t.Helper()
	if err := s.Prepare(context.Background()); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if p := s.Problem(); p != "" {
		t.Fatalf("problem after prepare: %s", p)
	}
}

func TestStoreHybridSearch(t *testing.T) {
	ctx := context.Background()
	e := &wordEmbedder{dims: 64}
	s := newTestStore(t, nil, e)
	mustPrepare(t, s)
	if s.Dims() != 64 {
		t.Fatalf("dims %d, want 64", s.Dims())
	}
	// Twice: the second time everything exists (another replica, a restart).
	mustPrepare(t, s)

	docs := []Document{
		{Title: "Refunds", Source: "kb/refunds.md", Content: "Customers get a refund within 14 days of purchase.", Metadata: map[string]any{"team": "support"}},
		{Title: "Shipping", Source: "kb/shipping.md", Content: "Orders ship from Amsterdam within two working days.", Metadata: map[string]any{"team": "logistics"}},
		{Title: "Returns", Source: "kb/returns.md", Content: "Return the product in its original box for a refund.", Metadata: map[string]any{"team": "support"}},
	}
	for _, d := range docs {
		if _, embedded, err := s.AddDocument(ctx, d); err != nil || !embedded {
			t.Fatalf("add %s: embedded %v, %v", d.Title, embedded, err)
		}
	}

	hits, warning, err := s.Search(ctx, "how do I get a refund", 2, nil)
	if err != nil || warning != "" {
		t.Fatalf("search: %v %q", err, warning)
	}
	if len(hits) != 2 || hits[0].Title != "Refunds" {
		t.Fatalf("hits %+v, want Refunds first of 2", hits)
	}
	for _, h := range hits {
		if h.Score <= 0 || h.ID == "" || h.Source == "" || h.Metadata["team"] == nil {
			t.Fatalf("hit without score, id, source or metadata: %+v", h)
		}
	}

	// Metadata filter.
	hits, _, err = s.Search(ctx, "refund ship days", 5, map[string]any{"team": "logistics"})
	if err != nil || len(hits) != 1 || hits[0].Title != "Shipping" {
		t.Fatalf("filtered hits %+v, %v", hits, err)
	}

	// Text alone still finds an exact term when the model is down.
	e.fail.Store(true)
	hits, warning, err = s.Search(ctx, "Amsterdam", 3, nil)
	if err != nil || !strings.Contains(warning, "full-text results only") || len(hits) != 1 || hits[0].Title != "Shipping" {
		t.Fatalf("text fallback: %+v %q %v", hits, warning, err)
	}
	e.fail.Store(false)

	// Fetch and delete.
	d, err := s.Fetch(ctx, hits[0].ID)
	if err != nil || d == nil || d.Content != docs[1].Content || d.Truncated {
		t.Fatalf("fetch: %+v %v", d, err)
	}
	if d, err := s.Fetch(ctx, "not-a-number"); d != nil || err != nil {
		t.Fatalf("fetch of a bad id: %+v %v", d, err)
	}
	if ok, err := s.DeleteDocument(ctx, hits[0].ID); !ok || err != nil {
		t.Fatalf("delete: %v %v", ok, err)
	}
	if ok, _ := s.DeleteDocument(ctx, hits[0].ID); ok {
		t.Fatal("deleted twice")
	}
}

func TestStoreSnippetAndIndexes(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t, func(c *Config) { c.Retrieval.TextSearchConfig = "english" }, &wordEmbedder{dims: 32})
	mustPrepare(t, s)
	long := strings.Repeat("kubernetes operators reconcile state. ", 100)
	if _, _, err := s.AddDocument(ctx, Document{Title: "Operators", Content: long}); err != nil {
		t.Fatal(err)
	}
	hits, _, err := s.Search(ctx, "operator reconciling", 3, nil)
	if err != nil || len(hits) != 1 || !hits[0].Truncated || len(hits[0].Content) != snippet {
		t.Fatalf("hits %+v %v", hits, err)
	}
	// The full-text index is the one the query's expression uses.
	var n int
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE schemaname = $1 AND indexname IN ('documents_fts_english', 'documents_embedding', 'memories_fts_english', 'memories_embedding')`,
		s.docs.schemaName).Scan(&n)
	if err != nil || n != 4 {
		t.Fatalf("indexes: %d %v", n, err)
	}
	tx, _ := s.pool.Begin(ctx)
	defer tx.Rollback(ctx) //nolint:errcheck
	_, _ = tx.Exec(ctx, "SET LOCAL enable_seqscan = off")
	var plan strings.Builder
	rows, err := tx.Query(ctx, fmt.Sprintf(`EXPLAIN SELECT 1 FROM %s d WHERE %s @@ websearch_to_tsquery('english', 'operator')`, s.docs.name, s.docs.fts()))
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var line string
		_ = rows.Scan(&line)
		plan.WriteString(line + "\n")
	}
	if !strings.Contains(plan.String(), "documents_fts_english") {
		t.Fatalf("full-text query doesn't use the index:\n%s", plan.String())
	}
}

func TestStoreMemoryScopes(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t, nil, &wordEmbedder{dims: 64})
	mustPrepare(t, s)

	idA, _, err := s.Remember(ctx, "agent-a", "The customer Acme prefers invoices in euros.", []string{"customer:acme", "preference"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Remember(ctx, "agent-a", "Deploys happen on Tuesdays.", nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Remember(ctx, "agent-b", "Acme's contact is Jo.", []string{"customer:acme"}); err != nil {
		t.Fatal(err)
	}

	got, _, err := s.Recall(ctx, "agent-a", "which currency does acme want", 5, nil)
	if err != nil || len(got) == 0 || got[0].ID != idA || got[0].Client != "" {
		t.Fatalf("recall: %+v %v", got, err)
	}
	for _, m := range got {
		if strings.Contains(m.Content, "Jo") {
			t.Fatalf("agent-a recalled agent-b's memory: %+v", m)
		}
	}
	// By tag, and the most recent without a query.
	got, _, _ = s.Recall(ctx, "agent-a", "", 5, []string{"preference"})
	if len(got) != 1 || got[0].ID != idA {
		t.Fatalf("by tag: %+v", got)
	}
	got, _, _ = s.Recall(ctx, "agent-a", "", 1, nil)
	if len(got) != 1 || got[0].Content != "Deploys happen on Tuesdays." {
		t.Fatalf("most recent: %+v", got)
	}
	// agent-b can't forget agent-a's memory.
	if ok, _ := s.Forget(ctx, "agent-b", idA); ok {
		t.Fatal("agent-b forgot agent-a's memory")
	}
	if ok, err := s.Forget(ctx, "agent-a", idA); !ok || err != nil {
		t.Fatalf("forget: %v %v", ok, err)
	}

	// Shared: everyone's, with who wrote it.
	s.cfg.Memory.Scope = ScopeShared
	got, _, _ = s.Recall(ctx, "agent-a", "acme", 5, nil)
	if len(got) == 0 || got[0].Client != "agent-b" || !strings.Contains(got[0].Content, "Jo") {
		t.Fatalf("shared recall: %+v", got)
	}
}

func TestStoreBackfillAndExpire(t *testing.T) {
	ctx := context.Background()
	e := &wordEmbedder{dims: 16}
	s := newTestStore(t, func(c *Config) { c.Memory.RetentionDays = 30 }, e)
	mustPrepare(t, s)

	e.fail.Store(true)
	if _, embedded, err := s.AddDocument(ctx, Document{Content: "stored while the model was down"}); err != nil || embedded {
		t.Fatalf("add: embedded %v %v", embedded, err)
	}
	if _, embedded, err := s.Remember(ctx, "agent-a", "remembered while the model was down", nil); err != nil || embedded {
		t.Fatalf("remember: embedded %v %v", embedded, err)
	}
	if _, err := s.Backfill(ctx, 10); err == nil {
		t.Fatal("backfill with the model down: want an error")
	}
	e.fail.Store(false)
	n, err := s.Backfill(ctx, 10)
	if err != nil || n != 2 {
		t.Fatalf("backfill: %d %v", n, err)
	}
	if n, _ := s.Backfill(ctx, 10); n != 0 {
		t.Fatalf("second backfill embedded %d", n)
	}

	if _, err := s.pool.Exec(ctx, fmt.Sprintf(`UPDATE %s SET created_at = now() - interval '40 days'`, s.mems.name)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Remember(ctx, "agent-a", "recent", nil); err != nil {
		t.Fatal(err)
	}
	if n, err := s.Expire(ctx); err != nil || n != 1 {
		t.Fatalf("expire: %d %v", n, err)
	}
}

func TestStoreTextOnly(t *testing.T) {
	ctx := context.Background()
	e := &wordEmbedder{dims: 8}
	s := newTestStore(t, func(c *Config) { c.Embeddings.Model = ""; c.Retrieval.Mode = ModeText }, e)
	mustPrepare(t, s)
	if _, embedded, err := s.AddDocument(ctx, Document{Title: "Backups", Content: "Barman archives WAL to object storage."}); err != nil || embedded {
		t.Fatalf("add: %v %v", embedded, err)
	}
	hits, _, err := s.Search(ctx, "barman", 3, nil)
	if err != nil || len(hits) != 1 {
		t.Fatalf("hits %+v %v", hits, err)
	}
	if _, _, err := s.Remember(ctx, "agent-a", "text only memory", nil); err != nil {
		t.Fatal(err)
	}
	if got, _, err := s.Recall(ctx, "agent-a", "memory", 3, nil); err != nil || len(got) != 1 {
		t.Fatalf("recall %+v %v", got, err)
	}
	if e.calls.Load() != 0 {
		t.Fatalf("the embedder was called %d times without a model", e.calls.Load())
	}
	// No vector columns at all.
	var n int
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'embedding'`, s.docs.schemaName).Scan(&n)
	if n != 0 {
		t.Fatalf("%d embedding columns without a model", n)
	}
}

func TestStoreOwnTable(t *testing.T) {
	ctx := context.Background()
	url := testURL(t)
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, stmt := range []string{
		`DROP SCHEMA IF EXISTS kb_own CASCADE`, `CREATE SCHEMA kb_own`,
		`CREATE TABLE kb_own.chunks (chunk_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL, url text, attrs jsonb, vec vector(16))`,
	} {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _, _ = conn.Exec(context.Background(), `DROP SCHEMA IF EXISTS kb_own CASCADE`) })
	e := &wordEmbedder{dims: 16}
	vecs, _ := e.Embed(ctx, []string{"vacation days per year", "office opening hours"})
	for i, body := range []string{"Employees get 25 vacation days per year.", "The office opens at 8."} {
		if _, err := conn.Exec(ctx, `INSERT INTO kb_own.chunks (body, url, attrs, vec) VALUES ($1, $2, $3, $4::vector)`,
			body, fmt.Sprintf("https://wiki/%d", i), map[string]any{"lang": "en"}, vectorLiteral(vecs[i])); err != nil {
			t.Fatal(err)
		}
	}

	s := newTestStore(t, func(c *Config) {
		c.Retrieval.Table = "kb_own.chunks"
		c.Retrieval.Columns = Columns{ID: "chunk_id", Content: "body", Source: "url", Metadata: "attrs", Embedding: "vec"}
		c.Memory.Enabled = false
	}, e)
	mustPrepare(t, s)
	hits, _, err := s.Search(ctx, "how many vacation days", 1, map[string]any{"lang": "en"})
	if err != nil || len(hits) != 1 || hits[0].Source != "https://wiki/0" || hits[0].Title != "" {
		t.Fatalf("hits %+v %v", hits, err)
	}
	d, err := s.Fetch(ctx, hits[0].ID)
	if err != nil || d == nil || !strings.HasPrefix(d.Content, "Employees") {
		t.Fatalf("fetch by uuid: %+v %v", d, err)
	}
	if d, err := s.Fetch(ctx, "42"); d != nil || err != nil {
		t.Fatalf("fetch of a non-uuid: %+v %v", d, err)
	}
	// Its table is read, never written: no indexes of the server's on it.
	var n int
	_ = conn.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE schemaname = 'kb_own' AND indexname <> 'chunks_pkey'`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d indexes created on a table of your own", n)
	}

	// A missing column is the store's problem, not a crash.
	s2 := newTestStore(t, func(c *Config) {
		c.Retrieval.Table = "kb_own.chunks"
		c.Retrieval.Columns = Columns{ID: "chunk_id", Content: "text"}
		c.Retrieval.Mode = ModeText
		c.Memory.Enabled = false
	}, e)
	if err := s2.Prepare(ctx); err == nil || !strings.Contains(s2.Problem(), "no column text") {
		t.Fatalf("missing column: %v / %q", err, s2.Problem())
	}
}

func TestStoreDimensionChange(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t, nil, &wordEmbedder{dims: 16})
	mustPrepare(t, s)
	// Another model with other dimensions, same tables.
	s.embed = &wordEmbedder{dims: 24}
	err := s.Prepare(ctx)
	if err == nil || !strings.Contains(err.Error(), "returns 24 dimensions, the tables hold 16") {
		t.Fatalf("want a dimensions error, got %v", err)
	}
}

func TestStoreNoVectorExtension(t *testing.T) {
	url := testURL(t)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// A database of its own without the extension.
	_, _ = conn.Exec(ctx, `DROP DATABASE IF EXISTS novector`)
	if _, err := conn.Exec(ctx, `CREATE DATABASE novector`); err != nil {
		t.Skipf("can't create a database: %v", err)
	}
	t.Cleanup(func() {
		c, _ := pgx.Connect(context.Background(), url)
		_, _ = c.Exec(context.Background(), `DROP DATABASE IF EXISTS novector WITH (FORCE)`)
		c.Close(context.Background())
	})
	cfg := &Config{Retrieval: Retrieval{Enabled: true}, Memory: Memory{Enabled: true}, Embeddings: Embeddings{Model: "words"}}
	cfg.defaults()
	i := strings.LastIndex(url, "/")
	other := url[:i] + "/novector"
	s, err := NewStore(ctx, other, cfg, &wordEmbedder{dims: 8})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.Prepare(ctx); err == nil || !strings.Contains(err.Error(), "no vector extension") {
		t.Fatalf("want the vector extension error, got %v", err)
	}
}

func TestStoreReadOnlyReplica(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t, nil, &wordEmbedder{dims: 8})
	mustPrepare(t, s)
	// As a standby site's database reports itself.
	s.mu.Lock()
	s.recoveryAt, s.inRecovery = time.Now().Add(time.Hour), true
	s.mu.Unlock()
	if _, _, err := s.Remember(ctx, "agent-a", "x", nil); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("remember on a replica: %v", err)
	}
	if _, _, err := s.AddDocument(ctx, Document{Content: "x"}); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("add on a replica: %v", err)
	}
	if _, _, err := s.Search(ctx, "x", 1, nil); err != nil {
		t.Fatalf("search on a replica: %v", err)
	}
	if n, err := s.Backfill(ctx, 10); n != 0 || err != nil {
		t.Fatalf("backfill on a replica: %d %v", n, err)
	}
	// It doesn't create tables, it waits for them.
	mustPrepare(t, s)
}

func TestStoreConcurrentPrepare(t *testing.T) {
	// Replicas starting together: the advisory lock serializes their DDL.
	ctx := context.Background()
	s := newTestStore(t, nil, &wordEmbedder{dims: 8})
	errs := make(chan error, 4)
	for range 4 {
		go func() { errs <- s.Prepare(ctx) }()
	}
	for range 4 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}
