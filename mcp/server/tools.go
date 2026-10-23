package server

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Backend is what the tools need from the store (a fake in tests).
type Backend interface {
	Problem() string
	Search(ctx context.Context, query string, k int, filter map[string]any) ([]Document, string, error)
	Fetch(ctx context.Context, id string) (*Document, error)
	AddDocument(ctx context.Context, d Document) (string, bool, error)
	DeleteDocument(ctx context.Context, id string) (bool, error)
	Remember(ctx context.Context, client, content string, tags []string) (int64, bool, error)
	Recall(ctx context.Context, client, query string, k int, tags []string) ([]MemoryItem, string, error)
	Forget(ctx context.Context, client string, id int64) (bool, error)
}

// Limits on what a call may send.
const (
	maxQuery    = 4000
	maxDocument = 200_000
	maxMemory   = 20_000
	maxTags     = 20
	maxLimit    = 50
)

type SearchIn struct {
	Query  string         `json:"query" jsonschema:"What to look for, in natural language or keywords"`
	Limit  int            `json:"limit,omitempty" jsonschema:"How many hits, 1 to 50; the server's topK by default"`
	Filter map[string]any `json:"filter,omitempty" jsonschema:"Only documents whose metadata contains this JSON object, e.g. {\"team\": \"support\"}"`
}

type SearchOut struct {
	Results []Document `json:"results"`
	Warning string     `json:"warning,omitempty"`
}

type FetchIn struct {
	ID string `json:"id" jsonschema:"A document id from search"`
}

type AddDocumentIn struct {
	Content  string         `json:"content" jsonschema:"The document's text"`
	Title    string         `json:"title,omitempty" jsonschema:"A title, searched along with the content"`
	Source   string         `json:"source,omitempty" jsonschema:"Where it comes from, e.g. a URL or file path"`
	Metadata map[string]any `json:"metadata,omitempty" jsonschema:"JSON object to filter searches on"`
}

type AddOut struct {
	ID string `json:"id"`
	// Embedded: false when the embeddings model was down; it is embedded later.
	Embedded bool `json:"embedded"`
}

type DeleteDocumentIn struct {
	ID string `json:"id" jsonschema:"The document's id"`
}

type DeletedOut struct {
	Deleted bool `json:"deleted"`
}

type RememberIn struct {
	Content string   `json:"content" jsonschema:"What to remember: a fact, preference, decision or outcome, self-contained"`
	Tags    []string `json:"tags,omitempty" jsonschema:"Labels to recall it by, e.g. [\"preference\", \"customer:acme\"]"`
}

type RememberOut struct {
	ID       int64 `json:"id"`
	Embedded bool  `json:"embedded"`
}

type RecallIn struct {
	Query string   `json:"query,omitempty" jsonschema:"What to recall; empty for the most recent memories"`
	Limit int      `json:"limit,omitempty" jsonschema:"How many, 1 to 50 (default 10)"`
	Tags  []string `json:"tags,omitempty" jsonschema:"Only memories with any of these tags"`
}

type RecallOut struct {
	Memories []MemoryItem `json:"memories"`
	Warning  string       `json:"warning,omitempty"`
}

type ForgetIn struct {
	ID int64 `json:"id" jsonschema:"The memory's id, from recall"`
}

type ForgetOut struct {
	Forgotten bool `json:"forgotten"`
}

// Tools builds an MCP server per client with the tools it may call.
type Tools struct {
	cfg     *Config
	backend Backend
	metrics *Metrics
	audit   *Audit
	version string
}

func NewTools(cfg *Config, backend Backend, metrics *Metrics, audit *Audit, version string) *Tools {
	return &Tools{cfg: cfg, backend: backend, metrics: metrics, audit: audit, version: version}
}

// call runs a tool's work with what every call gets: readiness, metrics and
// the audit line. results and id describe the outcome for the audit.
func call[In, Out any](t *Tools, tool, client string, work func(ctx context.Context, in In) (Out, *int, string, error)) mcp.ToolHandlerFor[In, Out] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, Out, error) {
		started := time.Now()
		var out Out
		var results *int
		var id string
		var err error
		if p := t.backend.Problem(); p != "" {
			err = fmt.Errorf("the server isn't ready: %s", p)
		} else {
			out, results, id, err = work(ctx, in)
		}
		outcome := "ok"
		rec := AuditRecord{Time: started.UTC().Format(time.RFC3339Nano), Client: client, Tool: tool, Results: results, ID: id}
		if err != nil {
			outcome = "error"
			rec.Error = truncate(err.Error(), 300)
		}
		rec.Outcome, rec.DurationMS = outcome, time.Since(started).Milliseconds()
		t.audit.write(rec)
		t.metrics.calls.WithLabelValues(tool, client, outcome).Inc()
		t.metrics.duration.WithLabelValues(tool).Observe(time.Since(started).Seconds())
		if results != nil && (tool == ToolSearch || tool == ToolRecall) {
			t.metrics.results.WithLabelValues(tool).Observe(float64(*results))
		}
		return nil, out, err
	}
}

func count(n int) *int { return &n }

func limit(n, def int) int {
	if n <= 0 {
		return def
	}
	return min(n, maxLimit)
}

func checkLen(field, s string, max int) error {
	if len(s) > max {
		return fmt.Errorf("%s is %d bytes; at most %d", field, len(s), max)
	}
	return nil
}

func checkTags(tags []string) error {
	if len(tags) > maxTags {
		return fmt.Errorf("%d tags; at most %d", len(tags), maxTags)
	}
	for _, tag := range tags {
		if tag == "" || len(tag) > 100 {
			return errors.New("a tag is 1 to 100 characters")
		}
	}
	return nil
}

func ptr(b bool) *bool { return &b }

// Server is the MCP server for client: its tools, and nothing else.
func (t *Tools) Server(client string) *mcp.Server {
	allowed := t.cfg.ClientTools(client)
	s := mcp.NewServer(&mcp.Implementation{Name: "basis-mcp", Title: "BASIS: " + t.cfg.Server, Version: t.version},
		&mcp.ServerOptions{Instructions: t.instructions(allowed)})
	has := func(tool string) bool { return slices.Contains(allowed, tool) }
	r := t.cfg.Retrieval
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: ptr(false)}

	if has(ToolSearch) {
		mcp.AddTool(s, &mcp.Tool{Name: ToolSearch, Title: "Search the knowledge base", Annotations: readOnly,
			Description: fmt.Sprintf("Searches the project's documents (%s search) and returns the best hits, best first, each with an id, "+
				"title, source and the first %d characters of its content. Use fetch for a whole document.", r.Mode, snippet)},
			call(t, ToolSearch, client, func(ctx context.Context, in SearchIn) (SearchOut, *int, string, error) {
				if strings.TrimSpace(in.Query) == "" {
					return SearchOut{}, nil, "", errors.New("query is empty")
				}
				if err := checkLen("query", in.Query, maxQuery); err != nil {
					return SearchOut{}, nil, "", err
				}
				docs, warning, err := t.backend.Search(ctx, in.Query, limit(in.Limit, r.TopK), in.Filter)
				if docs == nil {
					docs = []Document{}
				}
				return SearchOut{Results: docs, Warning: warning}, count(len(docs)), "", err
			}))
	}
	if has(ToolFetch) {
		mcp.AddTool(s, &mcp.Tool{Name: ToolFetch, Title: "Fetch a document", Annotations: readOnly,
			Description: "Returns a whole document by the id search gave."},
			call(t, ToolFetch, client, func(ctx context.Context, in FetchIn) (Document, *int, string, error) {
				d, err := t.backend.Fetch(ctx, in.ID)
				if err == nil && d == nil {
					err = fmt.Errorf("no document %q", in.ID)
				}
				if err != nil {
					return Document{}, nil, in.ID, err
				}
				return *d, count(1), in.ID, nil
			}))
	}
	if has(ToolAddDocument) {
		mcp.AddTool(s, &mcp.Tool{Name: ToolAddDocument, Title: "Add a document",
			Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(false)},
			Description: "Adds a document to the knowledge base, searchable right away. Split long texts into sections of a few " +
				"paragraphs, one document each, with the same source."},
			call(t, ToolAddDocument, client, func(ctx context.Context, in AddDocumentIn) (AddOut, *int, string, error) {
				if strings.TrimSpace(in.Content) == "" {
					return AddOut{}, nil, "", errors.New("content is empty")
				}
				if err := checkLen("content", in.Content, maxDocument); err != nil {
					return AddOut{}, nil, "", err
				}
				id, embedded, err := t.backend.AddDocument(ctx, Document{Content: in.Content, Title: in.Title, Source: in.Source, Metadata: in.Metadata})
				return AddOut{ID: id, Embedded: embedded}, count(1), id, err
			}))
	}
	if has(ToolDeleteDocument) {
		mcp.AddTool(s, &mcp.Tool{Name: ToolDeleteDocument, Title: "Delete a document",
			Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(true), IdempotentHint: true, OpenWorldHint: ptr(false)},
			Description: "Removes a document from the knowledge base."},
			call(t, ToolDeleteDocument, client, func(ctx context.Context, in DeleteDocumentIn) (DeletedOut, *int, string, error) {
				ok, err := t.backend.DeleteDocument(ctx, in.ID)
				return DeletedOut{Deleted: ok}, count(boolCount(ok)), in.ID, err
			}))
	}
	scope := "your own: other clients don't see them"
	if t.cfg.Memory.Scope == ScopeShared {
		scope = "shared by every client of this server"
	}
	if has(ToolRemember) {
		mcp.AddTool(s, &mcp.Tool{Name: ToolRemember, Title: "Remember",
			Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(false)},
			Description: "Stores a memory for later conversations: one self-contained fact, preference, decision or outcome per call. " +
				"Memories are " + scope + "."},
			call(t, ToolRemember, client, func(ctx context.Context, in RememberIn) (RememberOut, *int, string, error) {
				if strings.TrimSpace(in.Content) == "" {
					return RememberOut{}, nil, "", errors.New("content is empty")
				}
				if err := checkLen("content", in.Content, maxMemory); err != nil {
					return RememberOut{}, nil, "", err
				}
				if err := checkTags(in.Tags); err != nil {
					return RememberOut{}, nil, "", err
				}
				id, embedded, err := t.backend.Remember(ctx, client, in.Content, in.Tags)
				return RememberOut{ID: id, Embedded: embedded}, count(1), idString(id), err
			}))
	}
	if has(ToolRecall) {
		mcp.AddTool(s, &mcp.Tool{Name: ToolRecall, Title: "Recall", Annotations: readOnly,
			Description: "Returns the memories most relevant to a query, best first, or the most recent ones without a query. " +
				"Memories are " + scope + "."},
			call(t, ToolRecall, client, func(ctx context.Context, in RecallIn) (RecallOut, *int, string, error) {
				if err := checkLen("query", in.Query, maxQuery); err != nil {
					return RecallOut{}, nil, "", err
				}
				if err := checkTags(in.Tags); err != nil {
					return RecallOut{}, nil, "", err
				}
				items, warning, err := t.backend.Recall(ctx, client, in.Query, limit(in.Limit, 10), in.Tags)
				if items == nil {
					items = []MemoryItem{}
				}
				return RecallOut{Memories: items, Warning: warning}, count(len(items)), "", err
			}))
	}
	if has(ToolForget) {
		mcp.AddTool(s, &mcp.Tool{Name: ToolForget, Title: "Forget",
			Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(true), IdempotentHint: true, OpenWorldHint: ptr(false)},
			Description: "Deletes a memory by its id (from recall), e.g. when it is wrong or outdated."},
			call(t, ToolForget, client, func(ctx context.Context, in ForgetIn) (ForgetOut, *int, string, error) {
				ok, err := t.backend.Forget(ctx, client, in.ID)
				return ForgetOut{Forgotten: ok}, count(boolCount(ok)), idString(in.ID), err
			}))
	}
	return s
}

func (t *Tools) instructions(allowed []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "MCP server %s of BASIS project %s.", t.cfg.Server, t.cfg.Namespace)
	if slices.Contains(allowed, ToolSearch) {
		b.WriteString(" Search the project's knowledge base before answering from general knowledge, and cite the source of what you use.")
	}
	if slices.Contains(allowed, ToolRecall) {
		b.WriteString(" Recall memories at the start of a task; remember what will matter in later conversations (preferences, decisions, outcomes), never secrets.")
	}
	if len(allowed) == 0 {
		b.WriteString(" This client may call no tools.")
	}
	return b.String()
}

func boolCount(ok bool) int {
	if ok {
		return 1
	}
	return 0
}

func idString(id int64) string {
	if id == 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}
