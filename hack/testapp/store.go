package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the photo library in the stack's PostgreSQL, schema lens: the
// photos (display size and thumbnail), what the vision model said about
// them, their embeddings, and the library version.
type Store struct {
	db  *pgxpool.Pool
	dim int
	// minSimilarity drops vector matches below it (cosine): a library
	// without a dog shouldn't answer "a dog" with its least unlike photos.
	minSimilarity float64
}

// Photo is a library entry, without its image bytes.
type Photo struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	Caption   string    `json:"caption"`
	Tags      []string  `json:"tags"`
	Author    string    `json:"author,omitempty"`
	SourceURL string    `json:"sourceUrl,omitempty"`
	Width     int       `json:"width"`
	Height    int       `json:"height"`
	CreatedAt time.Time `json:"createdAt"`
	// In search results: the fused score and the rank in each search.
	Score      float64  `json:"score,omitempty"`
	Similarity *float64 `json:"similarity,omitempty"`
	VectorRank *int     `json:"vectorRank,omitempty"`
	TextRank   *int     `json:"textRank,omitempty"`
}

const photoColumns = "id, title, caption, tags, author, source_url, width, height, created_at"

func scanPhoto(row pgx.Row, extra ...any) (Photo, error) {
	var p Photo
	err := row.Scan(append([]any{&p.ID, &p.Title, &p.Caption, &p.Tags, &p.Author, &p.SourceURL, &p.Width, &p.Height, &p.CreatedAt}, extra...)...)
	return p, err
}

func NewStore(ctx context.Context, url string, dim int, minSimilarity float64) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Store{db: db, dim: dim, minSimilarity: minSimilarity}, nil
}

// ReadOnly is true in the standby site: its database is a replica.
func (s *Store) ReadOnly(ctx context.Context) (bool, error) {
	var ro bool
	err := s.db.QueryRow(ctx, "SELECT pg_is_in_recovery()").Scan(&ro)
	return ro, err
}

// Migrate creates the schema. pgvector's HNSW indexes vectors of up to 2000
// dimensions; the embeddings are asked for at EMBED_DIM (1024).
func (s *Store) Migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE EXTENSION IF NOT EXISTS vector`,
		`CREATE SCHEMA IF NOT EXISTS lens`,
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS lens.photos (
			id bigserial PRIMARY KEY,
			sha256 text NOT NULL UNIQUE,
			title text NOT NULL,
			caption text NOT NULL,
			tags text[] NOT NULL,
			-- the tags as words for the full-text index (array_to_string isn't immutable)
			tags_text text NOT NULL,
			author text NOT NULL DEFAULT '',
			source_url text NOT NULL DEFAULT '',
			width int NOT NULL,
			height int NOT NULL,
			image bytea NOT NULL,
			thumb bytea NOT NULL,
			embedding vector(%d) NOT NULL,
			tsv tsvector GENERATED ALWAYS AS (
				setweight(to_tsvector('english', title), 'A') ||
				setweight(to_tsvector('english', tags_text), 'A') ||
				setweight(to_tsvector('english', caption), 'B')) STORED,
			created_at timestamptz NOT NULL DEFAULT now())`, s.dim),
		`CREATE INDEX IF NOT EXISTS photos_embedding ON lens.photos USING hnsw (embedding vector_cosine_ops)`,
		`CREATE INDEX IF NOT EXISTS photos_tsv ON lens.photos USING gin (tsv)`,
		// One row: bumped with every change to the library, and part of the
		// search cache's keys, so a new photo shows up in the next search.
		`CREATE TABLE IF NOT EXISTS lens.library (
			id int PRIMARY KEY CHECK (id = 1),
			version bigint NOT NULL,
			updated_at timestamptz NOT NULL DEFAULT now())`,
		`INSERT INTO lens.library (id, version) VALUES (1, 0) ON CONFLICT DO NOTHING`,
		`CREATE TABLE IF NOT EXISTS lens.searches (
			id bigserial PRIMARY KEY,
			at timestamptz NOT NULL DEFAULT now(),
			query text NOT NULL,
			cache text NOT NULL,
			results int NOT NULL,
			total_ms int NOT NULL,
			site text NOT NULL)`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(ctx, q); err != nil {
			return fmt.Errorf("%.60s...: %w", strings.Join(strings.Fields(q), " "), err)
		}
	}
	return nil
}

// Version is the library version the search cache's keys carry.
func (s *Store) Version(ctx context.Context) (int64, error) {
	var v int64
	err := s.db.QueryRow(ctx, "SELECT version FROM lens.library WHERE id = 1").Scan(&v)
	return v, noSchema(err)
}

// Stats are the library as the UI shows it.
type Stats struct {
	Photos    int       `json:"photos"`
	Version   int64     `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
	Bytes     int64     `json:"bytes"`
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var st Stats
	err := s.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM lens.photos),
		(SELECT coalesce(sum(length(image) + length(thumb)), 0) FROM lens.photos), version, updated_at
		FROM lens.library WHERE id = 1`).Scan(&st.Photos, &st.Bytes, &st.Version, &st.UpdatedAt)
	return st, noSchema(err)
}

// Has reports whether a photo with these bytes is in the library already.
func (s *Store) Has(ctx context.Context, sha string) (int64, bool, error) {
	var id int64
	err := s.db.QueryRow(ctx, "SELECT id FROM lens.photos WHERE sha256 = $1", sha).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	return id, err == nil, noSchema(err)
}

// NewPhoto is what Add stores.
type NewPhoto struct {
	SHA256         string
	Desc           Description
	Author, Source string
	Image          *Prepared
	Embedding      []float32
}

// Add stores a photo and bumps the library version in one transaction.
func (s *Store) Add(ctx context.Context, n NewPhoto) (Photo, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Photo{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // after Commit, a no-op
	p, err := scanPhoto(tx.QueryRow(ctx, `INSERT INTO lens.photos
		(sha256, title, caption, tags, tags_text, author, source_url, width, height, image, thumb, embedding)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)
		RETURNING `+photoColumns,
		n.SHA256, n.Desc.Title, n.Desc.Caption, n.Desc.Tags, strings.Join(n.Desc.Tags, " "), n.Author, n.Source, n.Image.Width, n.Image.Height,
		n.Image.Display, n.Image.Thumb, vectorText(n.Embedding)))
	if err != nil {
		return Photo{}, err
	}
	if _, err := tx.Exec(ctx, "UPDATE lens.library SET version = version + 1, updated_at = now() WHERE id = 1"); err != nil {
		return Photo{}, err
	}
	return p, tx.Commit(ctx)
}

// Delete removes a photo and bumps the library version.
func (s *Store) Delete(ctx context.Context, id int64) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // after Commit, a no-op
	tag, err := tx.Exec(ctx, "DELETE FROM lens.photos WHERE id = $1", id)
	if err != nil || tag.RowsAffected() == 0 {
		return false, err
	}
	if _, err := tx.Exec(ctx, "UPDATE lens.library SET version = version + 1, updated_at = now() WHERE id = 1"); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// Get returns a photo's details.
func (s *Store) Get(ctx context.Context, id int64) (Photo, error) {
	return scanPhoto(s.db.QueryRow(ctx, "SELECT "+photoColumns+" FROM lens.photos WHERE id = $1", id))
}

// Image returns a photo's display JPEG, or its thumbnail.
func (s *Store) Image(ctx context.Context, id int64, thumb bool) ([]byte, error) {
	col := "image"
	if thumb {
		col = "thumb"
	}
	var b []byte
	err := s.db.QueryRow(ctx, "SELECT "+col+" FROM lens.photos WHERE id = $1", id).Scan(&b)
	return b, err
}

// Latest is the library, newest first.
func (s *Store) Latest(ctx context.Context, limit int) ([]Photo, error) {
	return s.photos(ctx, "SELECT "+photoColumns+" FROM lens.photos ORDER BY id DESC LIMIT $1", limit)
}

// ByIDs returns the photos in the given order (a cached result).
func (s *Store) ByIDs(ctx context.Context, ids []int64) ([]Photo, error) {
	all, err := s.photos(ctx, "SELECT "+photoColumns+" FROM lens.photos WHERE id = ANY($1)", ids)
	if err != nil {
		return nil, err
	}
	byID := map[int64]Photo{}
	for _, p := range all {
		byID[p.ID] = p
	}
	out := []Photo{}
	for _, id := range ids {
		if p, ok := byID[id]; ok {
			out = append(out, p)
		}
	}
	return out, nil
}

func (s *Store) photos(ctx context.Context, q string, args ...any) ([]Photo, error) {
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, noSchema(err)
	}
	defer rows.Close()
	out := []Photo{}
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Search finds photos for a query: the nearest images to its embedding
// (at least minSimilarity) and the best matches of its words in the titles,
// tags and captions, merged by reciprocal rank fusion. A query without text (an image, or
// "more like this") is the vector search alone.
func (s *Store) Search(ctx context.Context, vec []float32, text string, limit int, exclude int64) ([]Photo, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only
	if _, err := tx.Exec(ctx, "SET LOCAL hnsw.ef_search = 100"); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
WITH v AS (
	SELECT id, 1 - (embedding <=> $1::vector) AS sim, row_number() OVER (ORDER BY embedding <=> $1::vector) AS r
	FROM (SELECT id, embedding FROM lens.photos WHERE id <> $4 ORDER BY embedding <=> $1::vector LIMIT 60) nearest
	WHERE 1 - (embedding <=> $1::vector) >= $5
), t AS (
	SELECT id, row_number() OVER (ORDER BY ts_rank_cd(tsv, q) DESC) AS r
	FROM lens.photos, websearch_to_tsquery('english', $2) q
	WHERE $2 <> '' AND tsv @@ q AND id <> $4
	ORDER BY ts_rank_cd(tsv, q) DESC LIMIT 60
)
SELECT `+prefixed("p.", photoColumns)+`,
       coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + t.r), 0) AS score, v.sim, v.r, t.r
FROM (SELECT id FROM v UNION SELECT id FROM t) ids
JOIN lens.photos p USING (id)
LEFT JOIN v USING (id)
LEFT JOIN t USING (id)
ORDER BY score DESC
LIMIT $3`, vectorText(vec), text, limit, exclude, s.minSimilarity)
	if err != nil {
		return nil, noSchema(err)
	}
	defer rows.Close()
	out := []Photo{}
	for rows.Next() {
		var vr, tr *int64
		var score float64
		var sim *float64
		p, err := scanPhoto(rows, &score, &sim, &vr, &tr)
		if err != nil {
			return nil, err
		}
		p.Score, p.Similarity, p.VectorRank, p.TextRank = score, sim, intp(vr), intp(tr)
		out = append(out, p)
	}
	return out, rows.Err()
}

// Embedding returns a photo's embedding, for "more like this".
func (s *Store) Embedding(ctx context.Context, id int64) ([]float32, error) {
	var text string
	if err := s.db.QueryRow(ctx, "SELECT embedding::text FROM lens.photos WHERE id = $1", id).Scan(&text); err != nil {
		return nil, err
	}
	return parseVector(text)
}

// Search is one entry of the search log.
type SearchLog struct {
	At      time.Time `json:"at"`
	Query   string    `json:"query"`
	Cache   string    `json:"cache"`
	Results int       `json:"results"`
	TotalMs int       `json:"totalMs"`
	Site    string    `json:"site"`
}

func (s *Store) LogSearch(ctx context.Context, l SearchLog) error {
	_, err := s.db.Exec(ctx, `INSERT INTO lens.searches (query, cache, results, total_ms, site) VALUES ($1, $2, $3, $4, $5)`,
		l.Query, l.Cache, l.Results, l.TotalMs, l.Site)
	return err
}

func (s *Store) Searches(ctx context.Context, n int) ([]SearchLog, error) {
	rows, err := s.db.Query(ctx, `SELECT at, query, cache, results, total_ms, site FROM lens.searches ORDER BY id DESC LIMIT $1`, n)
	if err != nil {
		return nil, noSchema(err)
	}
	defer rows.Close()
	out := []SearchLog{}
	for rows.Next() {
		var l SearchLog
		if err := rows.Scan(&l.At, &l.Query, &l.Cache, &l.Results, &l.TotalMs, &l.Site); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// errNoSchema: an empty library (the standby's replica gets the schema from the active site).
var errNoSchema = errors.New("the library is empty: add photos in the active site first")

func noSchema(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && (pg.Code == "42P01" || pg.Code == "3F000") { // undefined table, schema
		return errNoSchema
	}
	return err
}

func prefixed(prefix, columns string) string {
	cols := strings.Split(columns, ", ")
	for i, c := range cols {
		cols[i] = prefix + c
	}
	return strings.Join(cols, ", ")
}

func vectorText(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 12)
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

func parseVector(s string) ([]float32, error) {
	s = strings.Trim(s, "[]")
	if s == "" {
		return nil, nil
	}
	parts := strings.Split(s, ",")
	out := make([]float32, len(parts))
	for i, p := range parts {
		f, err := strconv.ParseFloat(p, 32)
		if err != nil {
			return nil, err
		}
		out[i] = float32(f)
	}
	return out, nil
}

func intp(v *int64) *int {
	if v == nil {
		return nil
	}
	i := int(*v)
	return &i
}
