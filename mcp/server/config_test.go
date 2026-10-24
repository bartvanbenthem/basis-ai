package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"server":"kb","retrieval":{"enabled":true},"memory":{"enabled":true},
		"embeddings":{"model":"text-embedding-3-small"},"clients":{"agents":{}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	r := c.Retrieval
	if r.Table != "mcp.documents" || !r.Own || r.Mode != ModeHybrid || r.TopK != 8 || r.TextSearchConfig != "simple" ||
		r.Columns.Embedding != "embedding" || c.Memory.Table != "mcp.memories" || c.Memory.Scope != ScopeClient {
		t.Fatalf("defaults: %+v", c)
	}
	if got := c.ClientTools("agents"); !slices.Equal(got, []string{ToolSearch, ToolFetch, ToolRemember, ToolRecall, ToolForget}) {
		t.Fatalf("agents' tools %v", got)
	}
}

func TestValidate(t *testing.T) {
	for name, tc := range map[string]struct {
		edit func(*Config)
		want string
	}{
		"injection in a table":     {func(c *Config) { c.Retrieval.Table = `public.docs"; DROP TABLE x; --` }, "want schema.table"},
		"injection in a column":    {func(c *Config) { c.Retrieval.Columns.Content = "body) --" }, "not a column name"},
		"injection in a ts config": {func(c *Config) { c.Retrieval.TextSearchConfig = "english'::regconfig" }, "not a text search configuration"},
		"vector without a model":   {func(c *Config) { c.Embeddings.Model = "" }, "needs embeddings.model"},
		"ingest into your table":   {func(c *Config) { c.Retrieval.Table, c.Retrieval.Own, c.Retrieval.Ingest = "app.docs", false, true }, "server's own table"},
		"unknown tool":             {func(c *Config) { c.Clients["x"] = Client{Tools: []string{"drop_table"}} }, `unknown tool "drop_table"`},
		"topK":                     {func(c *Config) { c.Retrieval.TopK = 51 }, "1 to 50"},
	} {
		t.Run(name, func(t *testing.T) {
			c := &Config{Retrieval: Retrieval{Enabled: true}, Memory: Memory{Enabled: true}, Embeddings: Embeddings{Model: "m"}, Clients: map[string]Client{}}
			c.defaults()
			tc.edit(c)
			if err := c.Validate(); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}
}

func TestClientTools(t *testing.T) {
	c := &Config{Retrieval: Retrieval{Enabled: true}, Memory: Memory{Enabled: false},
		Clients: map[string]Client{"a": {}, "b": {Tools: []string{ToolFetch, ToolRecall}}}}
	if got := c.ClientTools("a"); !slices.Equal(got, []string{ToolSearch, ToolFetch}) {
		t.Fatalf("a: %v", got)
	}
	// Only what the server serves: memory is off.
	if got := c.ClientTools("b"); !slices.Equal(got, []string{ToolFetch}) {
		t.Fatalf("b: %v", got)
	}
	if got := c.ClientTools("nobody"); got != nil {
		t.Fatalf("an unlisted client: %v", got)
	}
}

func TestOpenAIEmbedder(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" || r.Header.Get("Authorization") != "Bearer k" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		if got["model"] == "broken" {
			http.Error(w, `{"error":"model not found"}`, http.StatusNotFound)
			return
		}
		// Out of order, as some servers answer.
		_, _ = w.Write([]byte(`{"data":[{"index":1,"embedding":[0,1]},{"index":0,"embedding":[1,0]}]}`))
	}))
	defer srv.Close()
	var outcomes []string
	e := &OpenAIEmbedder{BaseURL: srv.URL + "/v1/", APIKey: "k", Model: "m", Dimensions: 2,
		Observe: func(o string, _ time.Duration) { outcomes = append(outcomes, o) }}
	vecs, err := e.Embed(context.Background(), []string{"a", "b"})
	if err != nil || len(vecs) != 2 || vecs[0][0] != 1 || vecs[1][1] != 1 {
		t.Fatalf("vectors %v %v", vecs, err)
	}
	if got["dimensions"] != float64(2) || got["encoding_format"] != "float" {
		t.Fatalf("request %v", got)
	}
	e.Model = "broken"
	if _, err := e.Embed(context.Background(), []string{"a"}); err == nil || !strings.Contains(err.Error(), "answered 404") {
		t.Fatalf("error %v", err)
	}
	if !slices.Equal(outcomes, []string{"ok", "error"}) {
		t.Fatalf("observed %v", outcomes)
	}
}
