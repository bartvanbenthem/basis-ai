// Package server is basis-mcp: the MCP server an MCPServer
// (ai.cndev.nl/v1alpha1) runs in its Project's location. It serves
// retrieval over a PostgreSQL database (search, fetch, and with ingest
// add_document, delete_document) and an agent's memory (remember, recall,
// forget) as MCP tools over streamable HTTP, to clients with a key of their
// own.
//
// Documents and memories live in the database: tables the server creates
// (mcp.documents, mcp.memories), or a documents table of your own it only
// reads. Search is hybrid by default: pgvector's cosine distance over
// embeddings from an OpenAI-compatible endpoint (the Project's
// ModelGateway), and PostgreSQL's full-text search, fused by reciprocal
// rank. Memories are each client's own unless memory.scope is shared.
//
// Every call writes one JSON line to stdout (basis: mcp; client, tool,
// outcome, no query or content): the portal's audit trail.
package server

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
)

// Tool names.
const (
	ToolSearch         = "search"
	ToolFetch          = "fetch"
	ToolAddDocument    = "add_document"
	ToolDeleteDocument = "delete_document"
	ToolRemember       = "remember"
	ToolRecall         = "recall"
	ToolForget         = "forget"
)

// AllTools in the order tools/list shows them.
var AllTools = []string{ToolSearch, ToolFetch, ToolAddDocument, ToolDeleteDocument, ToolRemember, ToolRecall, ToolForget}

// Search modes.
const (
	ModeHybrid = "hybrid"
	ModeVector = "vector"
	ModeText   = "text"
)

// Memory scopes.
const (
	ScopeClient = "client"
	ScopeShared = "shared"
)

// Config is what the composition writes into the server's ConfigMap
// (config.json). Its JSON mirrors the MCPServer's spec, with the defaults
// already applied.
type Config struct {
	// Server and Namespace name the MCPServer, for logs and metrics.
	Server    string `json:"server"`
	Namespace string `json:"namespace"`
	// Site is the site this copy runs in (protected, recovery).
	Site       string     `json:"site"`
	Retrieval  Retrieval  `json:"retrieval"`
	Memory     Memory     `json:"memory"`
	Embeddings Embeddings `json:"embeddings"`
	// Clients by name; their keys are files in the keys directory.
	Clients map[string]Client `json:"clients"`
}

type Retrieval struct {
	Enabled bool `json:"enabled"`
	// Table is schema.table. Own: the server creates it (mcp.documents);
	// otherwise it's yours and only read, through Columns.
	Table   string  `json:"table"`
	Own     bool    `json:"own"`
	Columns Columns `json:"columns"`
	Mode    string  `json:"mode"`
	TopK    int     `json:"topK"`
	// TextSearchConfig is the PostgreSQL text search configuration
	// (simple, english, dutch, ...).
	TextSearchConfig string `json:"textSearchConfig"`
	// Ingest adds add_document and delete_document (own table only).
	Ingest bool `json:"ingest"`
}

// Columns of a documents table of your own. Content and ID are required;
// the others may be empty.
type Columns struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	Title     string `json:"title"`
	Source    string `json:"source"`
	Metadata  string `json:"metadata"`
	Embedding string `json:"embedding"`
}

type Memory struct {
	Enabled bool   `json:"enabled"`
	Table   string `json:"table"`
	Scope   string `json:"scope"`
	// RetentionDays deletes memories older than this; 0 keeps them.
	RetentionDays int `json:"retentionDays"`
}

type Embeddings struct {
	// Model at the OpenAI-compatible endpoint (OPENAI_BASE_URL); empty:
	// full-text search only.
	Model string `json:"model"`
	// Dimensions asks the model for this many (models that support it);
	// 0 takes the model's own.
	Dimensions int `json:"dimensions"`
}

type Client struct {
	// Tools the client may call; empty, every tool the server serves.
	Tools []string `json:"tools"`
}

var (
	qualifiedName = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$`)
	columnName    = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
	tsConfig      = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
)

// Load reads and checks a config file.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	c.defaults()
	if err := c.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &c, nil
}

func (c *Config) defaults() {
	r := &c.Retrieval
	if r.Table == "" {
		r.Table, r.Own = "mcp.documents", true
	}
	if r.Own {
		r.Columns = Columns{ID: "id", Content: "content", Title: "title", Source: "source", Metadata: "metadata", Embedding: "embedding"}
	}
	if r.Columns.ID == "" {
		r.Columns.ID = "id"
	}
	if r.Columns.Content == "" {
		r.Columns.Content = "content"
	}
	if r.Mode == "" {
		r.Mode = ModeHybrid
	}
	if r.TopK == 0 {
		r.TopK = 8
	}
	if r.TextSearchConfig == "" {
		r.TextSearchConfig = "simple"
	}
	if c.Memory.Table == "" {
		c.Memory.Table = "mcp.memories"
	}
	if c.Memory.Scope == "" {
		c.Memory.Scope = ScopeClient
	}
	if c.Clients == nil {
		c.Clients = map[string]Client{}
	}
}

// Validate checks what the SQL is built from: names are never quoted from
// untrusted input without passing these patterns.
func (c *Config) Validate() error {
	r := c.Retrieval
	if !qualifiedName.MatchString(r.Table) {
		return fmt.Errorf("retrieval.table %q: want schema.table, lowercase", r.Table)
	}
	if !qualifiedName.MatchString(c.Memory.Table) {
		return fmt.Errorf("memory.table %q: want schema.table, lowercase", c.Memory.Table)
	}
	for field, col := range map[string]string{"id": r.Columns.ID, "content": r.Columns.Content, "title": r.Columns.Title,
		"source": r.Columns.Source, "metadata": r.Columns.Metadata, "embedding": r.Columns.Embedding} {
		if col != "" && !columnName.MatchString(col) {
			return fmt.Errorf("retrieval.columns.%s %q: not a column name", field, col)
		}
	}
	if !tsConfig.MatchString(r.TextSearchConfig) {
		return fmt.Errorf("retrieval.textSearchConfig %q: not a text search configuration", r.TextSearchConfig)
	}
	if !slices.Contains([]string{ModeHybrid, ModeVector, ModeText}, r.Mode) {
		return fmt.Errorf("retrieval.mode %q: hybrid, vector or text", r.Mode)
	}
	if r.Mode != ModeText && c.Embeddings.Model == "" {
		// Without a model there is nothing to compare vectors with.
		return fmt.Errorf("retrieval.mode %s needs embeddings.model", r.Mode)
	}
	if r.TopK < 1 || r.TopK > 50 {
		return fmt.Errorf("retrieval.topK %d: 1 to 50", r.TopK)
	}
	if r.Ingest && !r.Own {
		return fmt.Errorf("retrieval.ingest is for the server's own table, not %s", r.Table)
	}
	if !slices.Contains([]string{ScopeClient, ScopeShared}, c.Memory.Scope) {
		return fmt.Errorf("memory.scope %q: client or shared", c.Memory.Scope)
	}
	for name, cl := range c.Clients {
		for _, t := range cl.Tools {
			if !slices.Contains(AllTools, t) {
				return fmt.Errorf("clients.%s.tools: unknown tool %q", name, t)
			}
		}
	}
	return nil
}

// Tools are the tools this server serves, whatever a client may call.
func (c *Config) Tools() []string {
	var out []string
	if c.Retrieval.Enabled {
		out = append(out, ToolSearch, ToolFetch)
		if c.Retrieval.Ingest {
			out = append(out, ToolAddDocument, ToolDeleteDocument)
		}
	}
	if c.Memory.Enabled {
		out = append(out, ToolRemember, ToolRecall, ToolForget)
	}
	return out
}

// ClientTools are the tools client may call: the server's, narrowed to its
// list if it has one. A client the config doesn't list gets none.
func (c *Config) ClientTools(client string) []string {
	served := c.Tools()
	cl, ok := c.Clients[client]
	if !ok {
		return nil
	}
	if len(cl.Tools) == 0 {
		return served
	}
	var out []string
	for _, t := range served {
		if slices.Contains(cl.Tools, t) {
			out = append(out, t)
		}
	}
	return out
}

// embeds: the server computes embeddings.
func (c *Config) embeds() bool { return c.Embeddings.Model != "" }
