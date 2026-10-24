package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Document is one search hit or fetched document.
type Document struct {
	ID       string         `json:"id"`
	Title    string         `json:"title,omitempty"`
	Source   string         `json:"source,omitempty"`
	Content  string         `json:"content"`
	Metadata map[string]any `json:"metadata,omitempty"`
	// Score: higher is better (reciprocal rank fusion, or one ranking's).
	Score float64 `json:"score,omitempty"`
	// Truncated: content was cut for the hit list; fetch has all of it.
	Truncated bool `json:"truncated,omitempty"`
}

// MemoryItem is one memory.
type MemoryItem struct {
	ID        int64     `json:"id"`
	Content   string    `json:"content"`
	Tags      []string  `json:"tags,omitempty"`
	Client    string    `json:"client,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	Score     float64   `json:"score,omitempty"`
}

// ErrReadOnly: the database here is a replica (a standby site's).
var ErrReadOnly = errors.New("this site's database is a read-only replica (the standby site); writes go to the active site")

// snippet is how much of a document's content a search hit carries.
const snippet = 1500

// candidates is how many rows each ranking contributes before fusion, per hit wanted.
const candidates = 4

// rrfK is reciprocal rank fusion's constant: a hit's score is the sum over
// rankings of 1/(rrfK + rank).
const rrfK = 60

// Store is the documents and memories in PostgreSQL.
type Store struct {
	pool  *pgxpool.Pool
	cfg   *Config
	embed Embedder

	docs, mems table

	mu      sync.RWMutex
	problem string // why the store isn't ready, "" when it is
	// dims of the vectors in the tables; 0 without embeddings.
	dims int
	// docID is the documents' id column type, for $n::type (fetch).
	docID string

	recoveryAt time.Time
	inRecovery bool
}

// table is a documents or memories table as the SQL refers to it, its
// identifiers quoted, its columns prefixed with the alias d.
type table struct {
	name                                        string // quoted schema.table
	id, content, title, source, metadata, embed string // d."col", or "" for none
	textConfig                                  string // regconfig literal
	// Unquoted, for the catalog and index names.
	schemaName, tableName, embedCol, cfgID string
	titleCol, contentCol                   string
}

func quote(id string) string { return `"` + strings.ReplaceAll(id, `"`, `""`) + `"` }

func newTable(qualified string, cols Columns, textConfig string) table {
	schema, name, _ := strings.Cut(qualified, ".")
	col := func(c string) string {
		if c == "" {
			return ""
		}
		return "d." + quote(c)
	}
	return table{
		name: quote(schema) + "." + quote(name),
		id:   col(cols.ID), content: col(cols.Content), title: col(cols.Title), source: col(cols.Source),
		metadata: col(cols.Metadata), embed: col(cols.Embedding),
		textConfig: "'" + textConfig + "'::regconfig",
		schemaName: schema, tableName: name, embedCol: cols.Embedding, cfgID: textConfig,
		titleCol: cols.Title, contentCol: cols.Content,
	}
}

// fts is the full-text vector of a row (alias d): title and content.
func (t table) fts() string { return t.ftsOf("d.") }

// ftsOf is fts with the columns qualified by prefix: "" for an index
// expression, which the planner matches to the query's whatever the alias.
func (t table) ftsOf(prefix string) string {
	content := prefix + quote(t.contentCol)
	if t.titleCol != "" {
		return fmt.Sprintf("to_tsvector(%s, coalesce(%s, '') || ' ' || coalesce(%s, ''))", t.textConfig, prefix+quote(t.titleCol), content)
	}
	return fmt.Sprintf("to_tsvector(%s, coalesce(%s, ''))", t.textConfig, content)
}

// NewStore connects; Prepare readies the tables.
func NewStore(ctx context.Context, url string, cfg *Config, embed Embedder) (*Store, error) {
	pc, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	pc.MaxConns = 10
	pc.ConnConfig.RuntimeParams["application_name"] = "basis-mcp"
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, err
	}
	s := &Store{pool: pool, cfg: cfg, embed: embed, problem: "not prepared yet"}
	s.docs = newTable(cfg.Retrieval.Table, cfg.Retrieval.Columns, cfg.Retrieval.TextSearchConfig)
	s.mems = newTable(cfg.Memory.Table, Columns{ID: "id", Content: "content", Embedding: "embedding"}, cfg.Retrieval.TextSearchConfig)
	if !cfg.embeds() {
		s.mems.embed, s.mems.embedCol = "", ""
		if cfg.Retrieval.Own {
			s.docs.embed, s.docs.embedCol = "", ""
		}
	}
	return s, nil
}

func (s *Store) Close() { s.pool.Close() }

// Problem is why the store can't serve yet, "" once it can.
func (s *Store) Problem() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.problem
}

func (s *Store) setProblem(p string) {
	s.mu.Lock()
	s.problem = p
	s.mu.Unlock()
}

// Dims is the embeddings' dimensions, 0 without.
func (s *Store) Dims() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.dims
}

// Prepare checks the database and creates the server's own tables and
// indexes (on the primary; a replica gets them through replication). Called
// until it succeeds; its error is also Problem.
func (s *Store) Prepare(ctx context.Context) error {
	err := s.prepare(ctx)
	if err != nil {
		s.setProblem(err.Error())
	} else {
		s.setProblem("")
	}
	return err
}

func (s *Store) prepare(ctx context.Context) error {
	if err := s.pool.Ping(ctx); err != nil {
		return fmt.Errorf("can't reach the database: %w", err)
	}
	needsVector := s.cfg.embeds() && (s.cfg.Memory.Enabled || (s.cfg.Retrieval.Enabled && s.docs.embed != ""))
	if needsVector {
		var ok bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')`).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return errors.New("the database has no vector extension: add vector to the PostgresCluster's database.extensions (a GenAIStack has it)")
		}
	}
	replica, err := s.readOnly(ctx)
	if err != nil {
		return err
	}

	// The vectors' dimensions: the existing columns', else the model's.
	dims := 0
	if needsVector {
		for _, t := range s.vectorTables() {
			d, err := s.columnDims(ctx, t)
			if err != nil {
				return err
			}
			if d > 0 && dims > 0 && d != dims {
				return fmt.Errorf("%s.%s has %d dimensions, another table %d: one embeddings model per server", t.schemaName, t.tableName, d, dims)
			}
			if d > 0 {
				dims = d
			}
		}
		probe, err := s.embed.Embed(ctx, []string{"dimensions"})
		if err != nil {
			return fmt.Errorf("embeddings model %s: %w", s.cfg.Embeddings.Model, err)
		}
		switch got := len(probe[0]); {
		case dims == 0:
			dims = got
		case got != dims:
			return fmt.Errorf("embeddings model %s returns %d dimensions, the tables hold %d: keep the model, or let the server re-embed into new tables (another retrieval.table / memory.table)",
				s.cfg.Embeddings.Model, got, dims)
		}
	}

	if !replica {
		if err := s.createTables(ctx, dims); err != nil {
			return err
		}
	}
	if s.cfg.Retrieval.Enabled {
		if err := s.checkDocuments(ctx, replica); err != nil {
			return err
		}
	}
	if s.cfg.Memory.Enabled && replica {
		if err := s.exists(ctx, s.mems); err != nil {
			return fmt.Errorf("%w (waiting for the primary to create it)", err)
		}
	}
	s.mu.Lock()
	s.dims = dims
	s.mu.Unlock()
	return nil
}

// vectorTables are the tables with an embedding column the server writes or reads.
func (s *Store) vectorTables() []table {
	var out []table
	if s.cfg.Retrieval.Enabled && s.docs.embed != "" {
		out = append(out, s.docs)
	}
	if s.cfg.Memory.Enabled {
		out = append(out, s.mems)
	}
	return out
}

// columnDims is the dimensions of t's embedding column, 0 if it (or t) doesn't exist yet.
func (s *Store) columnDims(ctx context.Context, t table) (int, error) {
	var typmod int
	err := s.pool.QueryRow(ctx, `
		SELECT a.atttypmod FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 AND NOT a.attisdropped`,
		t.schemaName, t.tableName, t.embedCol).Scan(&typmod)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	// vector(n) keeps n as its type modifier; a vector without one can't be indexed.
	if typmod <= 0 {
		return 0, fmt.Errorf("%s.%s.%s is a vector without dimensions; declare it vector(n)", t.schemaName, t.tableName, t.embedCol)
	}
	return typmod, nil
}

// lockID serializes the replicas' DDL (pg_advisory_xact_lock).
const lockID = 0x6261736973 // "basis"

func (s *Store) createTables(ctx context.Context, dims int) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // after Commit, a no-op
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, lockID); err != nil {
		return err
	}
	vector := func(t table) string {
		if t.embed == "" {
			return ""
		}
		return fmt.Sprintf(",\n  %s vector(%d)", quote(t.embedCol), dims)
	}
	var stmts []string
	addIndexes := func(t table, extra ...string) {
		stmts = append(stmts, fmt.Sprintf(`CREATE INDEX IF NOT EXISTS %s ON %s USING gin ((%s))`,
			quote(t.tableName+"_fts_"+t.cfgID), t.name, t.ftsOf("")))
		if t.embed != "" {
			// A vector column takes the embedding later, too (embeddings.model set afterwards).
			stmts = append(stmts, fmt.Sprintf(`ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s vector(%d)`, t.name, quote(t.embedCol), dims))
			// HNSW indexes vectors up to 2000 dimensions; bigger ones are searched without.
			if dims <= 2000 {
				stmts = append(stmts, fmt.Sprintf(`CREATE INDEX IF NOT EXISTS %s ON %s USING hnsw (%s vector_cosine_ops)`,
					quote(t.tableName+"_embedding"), t.name, quote(t.embedCol)))
			}
		}
		stmts = append(stmts, extra...)
	}
	if s.cfg.Retrieval.Enabled && s.cfg.Retrieval.Own {
		t := s.docs
		stmts = append(stmts, `CREATE SCHEMA IF NOT EXISTS `+quote(t.schemaName), fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text,
  source text,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()%s
)`, t.name, vector(t)))
		addIndexes(t, fmt.Sprintf(`CREATE INDEX IF NOT EXISTS %s ON %s USING gin (metadata jsonb_path_ops)`, quote(t.tableName+"_metadata"), t.name))
	}
	if s.cfg.Memory.Enabled {
		t := s.mems
		stmts = append(stmts, `CREATE SCHEMA IF NOT EXISTS `+quote(t.schemaName), fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client text NOT NULL,
  content text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()%s
)`, t.name, vector(t)))
		addIndexes(t, fmt.Sprintf(`CREATE INDEX IF NOT EXISTS %s ON %s (client, created_at DESC)`, quote(t.tableName+"_client"), t.name))
	}
	for _, stmt := range stmts {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("creating the server's tables: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) exists(ctx context.Context, t table) error {
	var ok bool
	if err := s.pool.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, t.schemaName+"."+t.tableName).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no table %s.%s", t.schemaName, t.tableName)
	}
	return nil
}

var sqlType = regexp.MustCompile(`^[a-z][a-z0-9 _]*(\([0-9, ]+\))?$`)

// checkDocuments: the documents table is there with the columns it's read
// through, and the id column's type is known (fetch casts to it).
func (s *Store) checkDocuments(ctx context.Context, replica bool) error {
	t := s.docs
	if err := s.exists(ctx, t); err != nil {
		if replica && s.cfg.Retrieval.Own {
			return fmt.Errorf("%w (waiting for the primary to create it)", err)
		}
		return err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT a.attname, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`, t.schemaName, t.tableName)
	if err != nil {
		return err
	}
	types := map[string]string{}
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			return err
		}
		types[name] = typ
	}
	if err := rows.Err(); err != nil {
		return err
	}
	cols := s.cfg.Retrieval.Columns
	for field, col := range map[string]string{"id": cols.ID, "content": cols.Content, "title": cols.Title,
		"source": cols.Source, "metadata": cols.Metadata, "embedding": t.embedCol} {
		if col != "" && types[col] == "" {
			return fmt.Errorf("%s.%s has no column %s (retrieval.columns.%s)", t.schemaName, t.tableName, col, field)
		}
	}
	if m := cols.Metadata; m != "" && types[m] != "jsonb" && types[m] != "json" {
		return fmt.Errorf("%s.%s.%s is %s; metadata must be jsonb or json", t.schemaName, t.tableName, m, types[m])
	}
	typ := types[cols.ID]
	if !sqlType.MatchString(typ) {
		typ = "text"
	}
	s.mu.Lock()
	s.docID = typ
	s.mu.Unlock()
	return nil
}

// readOnly: the database is a replica, checked at most every 10s.
func (s *Store) readOnly(ctx context.Context) (bool, error) {
	s.mu.RLock()
	fresh, ro := time.Since(s.recoveryAt) < 10*time.Second, s.inRecovery
	s.mu.RUnlock()
	if fresh {
		return ro, nil
	}
	if err := s.pool.QueryRow(ctx, `SELECT pg_is_in_recovery()`).Scan(&ro); err != nil {
		return false, err
	}
	s.mu.Lock()
	s.recoveryAt, s.inRecovery = time.Now(), ro
	s.mu.Unlock()
	return ro, nil
}

func (s *Store) writable(ctx context.Context) error {
	ro, err := s.readOnly(ctx)
	if err != nil {
		return err
	}
	if ro {
		return ErrReadOnly
	}
	return nil
}

// args numbers query parameters.
type args []any

func (a *args) add(v any) string {
	*a = append(*a, v)
	return "$" + strconv.Itoa(len(*a))
}

func vectorLiteral(v []float32) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(f), 'g', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

// ranked is the CTE "h" (id, score) of t's rows matching where, best
// first: by vector distance to vec, by full-text rank of query, or both
// fused by reciprocal rank. vec nil leaves the vector ranking out, query ""
// the text one.
func ranked(t table, a *args, query string, vec []float32, limit int, where string) string {
	if where == "" {
		where = "true"
	}
	var ctes, parts []string
	n := a.add(limit)
	if vec != nil && t.embed != "" {
		ctes = append(ctes, fmt.Sprintf(`v AS (SELECT id, row_number() OVER (ORDER BY dist) AS r FROM (
  SELECT %s AS id, %s <=> %s::vector AS dist FROM %s d WHERE %s IS NOT NULL AND %s ORDER BY dist LIMIT %s) s)`,
			t.id, t.embed, a.add(vectorLiteral(vec)), t.name, t.embed, where, n))
		parts = append(parts, "v")
	}
	if strings.TrimSpace(query) != "" {
		ctes = append(ctes, fmt.Sprintf(`f AS (SELECT id, row_number() OVER (ORDER BY rank DESC) AS r FROM (
  SELECT %s AS id, ts_rank_cd(%s, q) AS rank FROM %s d, websearch_to_tsquery(%s, %s) q WHERE %s @@ q AND %s ORDER BY rank DESC LIMIT %s) s)`,
			t.id, t.fts(), t.name, t.textConfig, a.add(query), t.fts(), where, n))
		parts = append(parts, "f")
	}
	var h string
	switch len(parts) {
	case 0:
		return ""
	case 1:
		h = fmt.Sprintf(`h AS (SELECT id, 1.0 / (%d + r) AS score FROM %s)`, rrfK, parts[0])
	default:
		h = fmt.Sprintf(`h AS (SELECT coalesce(v.id, f.id) AS id, coalesce(1.0 / (%d + v.r), 0) + coalesce(1.0 / (%d + f.r), 0) AS score
  FROM v FULL JOIN f ON v.id = f.id)`, rrfK, rrfK)
	}
	return "WITH " + strings.Join(append(ctes, h), ",\n")
}

// queryVector embeds a query for a vector ranking: nil (and a warning) when
// the mode leaves it out or the model can't be reached, then text alone ranks.
func (s *Store) queryVector(ctx context.Context, t table, query string) ([]float32, string, error) {
	if s.cfg.Retrieval.Mode == ModeText || t.embed == "" || strings.TrimSpace(query) == "" {
		return nil, "", nil
	}
	vecs, err := s.embed.Embed(ctx, []string{query})
	if err != nil {
		if s.cfg.Retrieval.Mode == ModeVector {
			return nil, "", err
		}
		return nil, "embeddings unavailable, full-text results only: " + err.Error(), nil
	}
	if d := s.Dims(); d > 0 && len(vecs[0]) != d {
		return nil, "", fmt.Errorf("the embeddings model returns %d dimensions, the table holds %d", len(vecs[0]), d)
	}
	return vecs[0], "", nil
}

func (s *Store) textQuery(query string) string {
	if s.cfg.Retrieval.Mode == ModeVector {
		return ""
	}
	return query
}

// Search ranks documents for query, those whose metadata contains filter.
func (s *Store) Search(ctx context.Context, query string, k int, filter map[string]any) ([]Document, string, error) {
	t := s.docs
	vec, warning, err := s.queryVector(ctx, t, query)
	if err != nil {
		return nil, "", err
	}
	var a args
	where := ""
	if len(filter) > 0 {
		if t.metadata == "" {
			return nil, "", errors.New("this documents table has no metadata column to filter on")
		}
		raw, _ := json.Marshal(filter)
		where = fmt.Sprintf("%s::jsonb @> %s::jsonb", t.metadata, a.add(string(raw)))
	}
	with := ranked(t, &a, s.textQuery(query), vec, k*candidates, where)
	if with == "" {
		return []Document{}, warning, nil
	}
	sql := fmt.Sprintf(`%s
SELECT %s::text, %s, %s, left(%s, %d), length(%s) > %d, %s, h.score::float8 FROM h JOIN %s d ON %s = h.id ORDER BY h.score DESC LIMIT %s`,
		with, t.id, orNull(t.title, "text"), orNull(t.source, "text"), t.content, snippet, t.content, snippet,
		orNull(jsonbOf(t.metadata), "jsonb"), t.name, t.id, a.add(k))
	rows, err := s.pool.Query(ctx, sql, a...)
	if err != nil {
		return nil, "", err
	}
	docs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Document, error) {
		var d Document
		var title, source *string
		err := row.Scan(&d.ID, &title, &source, &d.Content, &d.Truncated, &d.Metadata, &d.Score)
		d.Title, d.Source = deref(title), deref(source)
		return d, err
	})
	return docs, warning, err
}

// Fetch is one document, all of it; nil if there is none.
func (s *Store) Fetch(ctx context.Context, id string) (*Document, error) {
	t := s.docs
	s.mu.RLock()
	idType := or(s.docID, "bigint")
	s.mu.RUnlock()
	sql := fmt.Sprintf(`SELECT %s::text, %s, %s, %s, %s FROM %s d WHERE %s = $1::%s`,
		t.id, orNull(t.title, "text"), orNull(t.source, "text"), t.content, orNull(jsonbOf(t.metadata), "jsonb"), t.name, t.id, idType)
	var d Document
	var title, source *string
	err := s.pool.QueryRow(ctx, sql, id).Scan(&d.ID, &title, &source, &d.Content, &d.Metadata)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		// Not an id of the column's type: there's no such document.
		if strings.Contains(err.Error(), "invalid input syntax") {
			return nil, nil
		}
		return nil, err
	}
	d.Title, d.Source = deref(title), deref(source)
	return &d, nil
}

// AddDocument stores a document with its embedding; embedded false when the
// model couldn't be reached (the backfill embeds it later).
func (s *Store) AddDocument(ctx context.Context, d Document) (id string, embedded bool, err error) {
	if err := s.writable(ctx); err != nil {
		return "", false, err
	}
	vec := s.tryEmbed(ctx, s.docs, strings.TrimSpace(d.Title+"\n"+d.Content))
	meta := d.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	var a args
	cols := []string{"title", "source", "content", "metadata"}
	vals := []string{a.add(nullable(d.Title)), a.add(nullable(d.Source)), a.add(d.Content), a.add(meta) + "::jsonb"}
	if vec != nil {
		cols, vals = append(cols, quote(s.docs.embedCol)), append(vals, a.add(vectorLiteral(vec))+"::vector")
	}
	var n int64
	err = s.pool.QueryRow(ctx, fmt.Sprintf(`INSERT INTO %s (%s) VALUES (%s) RETURNING id`,
		s.docs.name, strings.Join(cols, ", "), strings.Join(vals, ", ")), a...).Scan(&n)
	return strconv.FormatInt(n, 10), vec != nil, err
}

// DeleteDocument removes a document; false if there was none.
func (s *Store) DeleteDocument(ctx context.Context, id string) (bool, error) {
	if err := s.writable(ctx); err != nil {
		return false, err
	}
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return false, nil
	}
	tag, err := s.pool.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE id = $1`, s.docs.name), n)
	return tag.RowsAffected() > 0, err
}

// memoryScope is the where clause limiting memories to client's.
func (s *Store) memoryScope(a *args, client string) string {
	if s.cfg.Memory.Scope == ScopeShared {
		return ""
	}
	return "d.client = " + a.add(client)
}

// Remember stores a memory of client's.
func (s *Store) Remember(ctx context.Context, client, content string, tags []string) (int64, bool, error) {
	if err := s.writable(ctx); err != nil {
		return 0, false, err
	}
	if tags == nil {
		tags = []string{}
	}
	vec := s.tryEmbed(ctx, s.mems, content)
	var a args
	cols := []string{"client", "content", "tags"}
	vals := []string{a.add(client), a.add(content), a.add(tags)}
	if vec != nil {
		cols, vals = append(cols, "embedding"), append(vals, a.add(vectorLiteral(vec))+"::vector")
	}
	var id int64
	err := s.pool.QueryRow(ctx, fmt.Sprintf(`INSERT INTO %s (%s) VALUES (%s) RETURNING id`,
		s.mems.name, strings.Join(cols, ", "), strings.Join(vals, ", ")), a...).Scan(&id)
	return id, vec != nil, err
}

// Recall is client's memories most like query, those with any of tags; with
// no query the most recent.
func (s *Store) Recall(ctx context.Context, client, query string, k int, tags []string) ([]MemoryItem, string, error) {
	t := s.mems
	var a args
	conds := []string{}
	if scope := s.memoryScope(&a, client); scope != "" {
		conds = append(conds, scope)
	}
	if len(tags) > 0 {
		conds = append(conds, "d.tags && "+a.add(tags)+"::text[]")
	}
	where := strings.Join(conds, " AND ")
	cols := "d.id, d.content, d.tags, d.client, d.created_at"
	scan := func(row pgx.CollectableRow) (MemoryItem, error) {
		var m MemoryItem
		err := row.Scan(&m.ID, &m.Content, &m.Tags, &m.Client, &m.CreatedAt, &m.Score)
		if s.cfg.Memory.Scope == ScopeClient {
			m.Client = ""
		}
		return m, err
	}
	var sql string
	var warning string
	if strings.TrimSpace(query) == "" {
		if where == "" {
			where = "true"
		}
		sql = fmt.Sprintf(`SELECT %s, 0::float8 FROM %s d WHERE %s ORDER BY d.created_at DESC LIMIT %s`, cols, t.name, where, a.add(k))
	} else {
		// Memories are short: always both rankings when there are embeddings.
		var vec []float32
		if t.embed != "" {
			vecs, err := s.embed.Embed(ctx, []string{query})
			if err != nil {
				warning = "embeddings unavailable, full-text results only: " + err.Error()
			} else {
				vec = vecs[0]
			}
		}
		with := ranked(t, &a, query, vec, k*candidates, where)
		sql = fmt.Sprintf(`%s
SELECT %s, h.score::float8 FROM h JOIN %s d ON d.id = h.id ORDER BY h.score DESC LIMIT %s`, with, cols, t.name, a.add(k))
	}
	rows, err := s.pool.Query(ctx, sql, a...)
	if err != nil {
		return nil, "", err
	}
	items, err := pgx.CollectRows(rows, scan)
	return items, warning, err
}

// Forget removes a memory of client's (any, with shared memory); false if there was none.
func (s *Store) Forget(ctx context.Context, client string, id int64) (bool, error) {
	if err := s.writable(ctx); err != nil {
		return false, err
	}
	var a args
	where := "d.id = " + a.add(id)
	if scope := s.memoryScope(&a, client); scope != "" {
		where += " AND " + scope
	}
	tag, err := s.pool.Exec(ctx, fmt.Sprintf(`DELETE FROM %s d WHERE %s`, s.mems.name, where), a...)
	return tag.RowsAffected() > 0, err
}

// tryEmbed is text's vector for t, nil without embeddings or when the model fails.
func (s *Store) tryEmbed(ctx context.Context, t table, text string) []float32 {
	if t.embed == "" {
		return nil
	}
	vecs, err := s.embed.Embed(ctx, []string{text})
	if err != nil || (s.Dims() > 0 && len(vecs[0]) != s.Dims()) {
		return nil
	}
	return vecs[0]
}

// Backfill embeds up to batch rows of the server's own tables that have no
// embedding yet (stored while the model was down, or before embeddings.model
// was set). It returns how many it embedded.
func (s *Store) Backfill(ctx context.Context, batch int) (int, error) {
	if ro, err := s.readOnly(ctx); err != nil || ro {
		return 0, err
	}
	var tables []table
	if s.cfg.Retrieval.Enabled && s.cfg.Retrieval.Own && s.docs.embed != "" {
		tables = append(tables, s.docs)
	}
	if s.cfg.Memory.Enabled && s.mems.embed != "" {
		tables = append(tables, s.mems)
	}
	done := 0
	for _, t := range tables {
		text := "d.content"
		if t.title != "" {
			text = "concat_ws(E'\\n', d.title, d.content)"
		}
		rows, err := s.pool.Query(ctx, fmt.Sprintf(`SELECT d.id, %s FROM %s d WHERE d.%s IS NULL ORDER BY d.id LIMIT $1`,
			text, t.name, quote(t.embedCol)), batch)
		if err != nil {
			return done, err
		}
		type pending struct {
			id   int64
			text string
		}
		todo, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (pending, error) {
			var p pending
			return p, row.Scan(&p.id, &p.text)
		})
		if err != nil || len(todo) == 0 {
			if err != nil {
				return done, err
			}
			continue
		}
		texts := make([]string, len(todo))
		for i, p := range todo {
			texts[i] = p.text
		}
		vecs, err := s.embed.Embed(ctx, texts)
		if err != nil {
			return done, err
		}
		b := &pgx.Batch{}
		for i, p := range todo {
			b.Queue(fmt.Sprintf(`UPDATE %s SET %s = $1::vector WHERE id = $2`, t.name, quote(t.embedCol)), vectorLiteral(vecs[i]), p.id)
		}
		if err := s.pool.SendBatch(ctx, b).Close(); err != nil {
			return done, err
		}
		done += len(todo)
	}
	return done, nil
}

// Expire deletes memories past memory.retentionDays; it returns how many.
func (s *Store) Expire(ctx context.Context) (int64, error) {
	days := s.cfg.Memory.RetentionDays
	if !s.cfg.Memory.Enabled || days <= 0 {
		return 0, nil
	}
	if ro, err := s.readOnly(ctx); err != nil || ro {
		return 0, err
	}
	tag, err := s.pool.Exec(ctx, fmt.Sprintf(`DELETE FROM %s WHERE created_at < now() - make_interval(days => $1)`, s.mems.name), days)
	return tag.RowsAffected(), err
}

// Ping: the database answers.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

func or(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func orNull(expr, typ string) string {
	if expr == "" {
		return "NULL::" + typ
	}
	return expr
}

func jsonbOf(expr string) string {
	if expr == "" {
		return ""
	}
	return expr + "::jsonb"
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
