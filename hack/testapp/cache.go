package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/valkey-io/valkey-go"
)

// Cache is the stack's Valkey, in front of the gateway and the database:
//
//   - query embeddings, by model and normalized text (no gateway call for a
//     query seen before)
//   - search results, exact (same words) and semantic: valkey-search KNN
//     over earlier queries' embeddings finds a paraphrase ("puppy at the
//     seaside" for "dog on a beach") and returns its results
//   - answers about a photo, by photo and normalized question
//
// Result keys carry the library version: a new photo makes older results
// unreachable. Everything expires on its own.
type Cache struct {
	c           valkey.Client
	dim         int
	ttl         time.Duration
	maxDistance float64
	// Semantic is false when the server has no valkey-search.
	Semantic bool
	Err      string
}

const (
	searchIndex  = "lens-searches"
	searchPrefix = "lens:sq:"
)

func NewCache(ctx context.Context, addr, password string, cluster bool, dim int, ttl time.Duration, maxDistance float64) (*Cache, error) {
	c, err := valkey.NewClient(valkey.ClientOption{
		InitAddress:       []string{addr},
		Password:          password,
		ForceSingleClient: !cluster,
		DisableCache:      true,
	})
	if err != nil {
		return nil, err
	}
	cache := &Cache{c: c, dim: dim, ttl: ttl, maxDistance: maxDistance}
	cache.ensureIndex(ctx)
	return cache, nil
}

// ensureIndex creates the vector index; without valkey-search, the cache is exact only.
func (c *Cache) ensureIndex(ctx context.Context) {
	err := c.c.Do(ctx, c.c.B().Arbitrary("FT.CREATE").Args(searchIndex, "ON", "HASH", "PREFIX", "1", searchPrefix,
		"SCHEMA", "vec", "VECTOR", "HNSW", "6", "TYPE", "FLOAT32", "DIM", strconv.Itoa(c.dim), "DISTANCE_METRIC", "COSINE",
		"lib", "TAG").Build()).Error()
	if err == nil || strings.Contains(strings.ToLower(err.Error()), "already exists") {
		c.Semantic, c.Err = true, ""
		return
	}
	c.Semantic, c.Err = false, fmt.Sprintf("semantic cache off: %v", err)
}

func (c *Cache) Ping(ctx context.Context) error {
	return c.c.Do(ctx, c.c.B().Ping().Build()).Error()
}

func normalize(q string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimRight(strings.TrimSpace(q), "?!. "))), " ")
}

func key(prefix string, parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return prefix + hex.EncodeToString(sum[:])
}

// libTag is the library version as a TAG value.
func libTag(version int64) string { return "v" + strconv.FormatInt(version, 10) }

func (c *Cache) get(ctx context.Context, k string, into any) (bool, error) {
	raw, err := c.c.Do(ctx, c.c.B().Get().Key(k).Build()).AsBytes()
	if valkey.IsValkeyNil(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(raw, into)
}

func (c *Cache) set(ctx context.Context, k string, v any, ttl time.Duration) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.c.Do(ctx, c.c.B().Set().Key(k).Value(string(raw)).ExSeconds(int64(ttl.Seconds())).Build()).Error()
}

// Embedding returns a cached query embedding.
func (c *Cache) Embedding(ctx context.Context, model, text string) ([]float32, bool, error) {
	raw, err := c.c.Do(ctx, c.c.B().Get().Key(key("lens:emb:", model, strconv.Itoa(c.dim), normalize(text))).Build()).AsBytes()
	if valkey.IsValkeyNil(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return fromBytes(raw), true, nil
}

// PutEmbedding keeps a query embedding: it doesn't change with the library.
func (c *Cache) PutEmbedding(ctx context.Context, model, text string, vec []float32) error {
	k := key("lens:emb:", model, strconv.Itoa(c.dim), normalize(text))
	return c.c.Do(ctx, c.c.B().Set().Key(k).Value(vecBytes(vec)).ExSeconds(int64((24 * time.Hour).Seconds())).Build()).Error()
}

// CachedSearch is what the search caches keep: the result's photo ids.
type CachedSearch struct {
	Query string  `json:"query"`
	IDs   []int64 `json:"ids"`
}

// ExactSearch returns the result of the same query in this library version.
func (c *Cache) ExactSearch(ctx context.Context, version int64, query string) (*CachedSearch, error) {
	var hit CachedSearch
	ok, err := c.get(ctx, key("lens:search:", libTag(version), normalize(query)), &hit)
	if !ok || err != nil {
		return nil, err
	}
	return &hit, nil
}

// SimilarSearch returns the result of the nearest earlier query in this
// library version within maxDistance (cosine), and that distance.
func (c *Cache) SimilarSearch(ctx context.Context, version int64, vec []float32) (*CachedSearch, float64, error) {
	if !c.Semantic {
		return nil, 0, nil
	}
	cmd := c.c.B().Arbitrary("FT.SEARCH").Args(searchIndex, fmt.Sprintf("@lib:{%s}=>[KNN 1 @vec $B AS dist]", libTag(version)),
		"PARAMS", "2", "B", vecBytes(vec), "DIALECT", "2").Build()
	arr, err := c.c.Do(ctx, cmd).ToArray()
	if err != nil {
		return nil, 0, err
	}
	// [total, key, [field, value, ...]]
	if len(arr) < 3 {
		return nil, 0, nil
	}
	fields, err := arr[2].AsStrMap()
	if err != nil {
		return nil, 0, err
	}
	dist, err := strconv.ParseFloat(fields["dist"], 64)
	if err != nil {
		return nil, 0, fmt.Errorf("semantic cache: distance %q", fields["dist"])
	}
	if dist > c.maxDistance {
		return nil, dist, nil
	}
	var hit CachedSearch
	return &hit, dist, json.Unmarshal([]byte(fields["result"]), &hit)
}

// PutSearch keeps a text search's result in both caches.
func (c *Cache) PutSearch(ctx context.Context, version int64, query string, vec []float32, ids []int64) error {
	res := CachedSearch{Query: query, IDs: ids}
	raw, err := json.Marshal(res)
	if err != nil {
		return err
	}
	secs := int64(c.ttl.Seconds())
	cmds := valkey.Commands{c.c.B().Set().Key(key("lens:search:", libTag(version), normalize(query))).Value(string(raw)).ExSeconds(secs).Build()}
	if c.Semantic {
		k := searchPrefix + randomID()
		cmds = append(cmds,
			c.c.B().Hset().Key(k).FieldValue().FieldValue("vec", vecBytes(vec)).FieldValue("lib", libTag(version)).
				FieldValue("result", string(raw)).Build(),
			c.c.B().Expire().Key(k).Seconds(secs).Build())
	}
	for _, r := range c.c.DoMulti(ctx, cmds...) {
		if err := r.Error(); err != nil {
			return err
		}
	}
	return nil
}

// Answer returns a cached answer about a photo.
func (c *Cache) Answer(ctx context.Context, model string, photo int64, question string, into any) (bool, error) {
	return c.get(ctx, key("lens:ask:", model, strconv.FormatInt(photo, 10), normalize(question)), into)
}

func (c *Cache) PutAnswer(ctx context.Context, model string, photo int64, question string, answer any) error {
	return c.set(ctx, key("lens:ask:", model, strconv.FormatInt(photo, 10), normalize(question)), answer, c.ttl)
}

// vecBytes is the vector as valkey-search reads FLOAT32: little endian.
func vecBytes(v []float32) string {
	b := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(f))
	}
	return string(b)
}

func fromBytes(b []byte) []float32 {
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[4*i:]))
	}
	return out
}

func randomID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
