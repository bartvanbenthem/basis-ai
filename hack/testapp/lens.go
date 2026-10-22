package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"
)

// Lens is the app: a photo library with search by meaning, on one stack.
type Lens struct {
	store   *Store
	cache   *Cache // nil without Valkey
	llm     *LLM
	site    string
	limit   int
	metrics *Metrics
	http    *http.Client // for the sample photos

	seedMu sync.Mutex
	seed   SeedStatus
}

// Timings are the milliseconds each step took.
type Timings map[string]int64

func (t Timings) lap(m *Metrics, stage string, since time.Time) {
	d := time.Since(since)
	t[stage] += d.Milliseconds()
	m.Observe(stage, d)
}

// Added is the result of adding a photo.
type Added struct {
	Photo     Photo   `json:"photo"`
	Duplicate bool    `json:"duplicate"`
	Timings   Timings `json:"timings"`
	Usage     Usage   `json:"usage"`
}

var errReadOnly = errors.New("this is the standby site: its database is a read-only replica; add photos in the active site")

// Add captions, tags and embeds a photo, then stores it. The vision model
// and the embedding model run at the same time.
func (l *Lens) Add(ctx context.Context, raw []byte, author, source string) (*Added, error) {
	t0 := time.Now()
	timings := Timings{}
	sum := sha256.Sum256(raw)
	sha := hex.EncodeToString(sum[:])
	if ro, err := l.store.ReadOnly(ctx); err != nil || ro {
		if err == nil {
			err = errReadOnly
		}
		return nil, err
	}
	if err := l.store.Migrate(ctx); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	if id, ok, err := l.store.Has(ctx, sha); err != nil {
		return nil, err
	} else if ok {
		p, err := l.store.Get(ctx, id)
		return &Added{Photo: p, Duplicate: true, Timings: Timings{"total": time.Since(t0).Milliseconds()}}, err
	}

	t := time.Now()
	img, err := Prepare(raw)
	if err != nil {
		return nil, err
	}
	timings.lap(l.metrics, "resize", t)

	var (
		wg        sync.WaitGroup
		desc      Description
		vec       []float32
		du, eu    Usage
		derr, eer error
		dd, ed    time.Duration
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		t := time.Now()
		desc, du, derr = l.llm.Describe(ctx, img.Display)
		dd = time.Since(t)
	}()
	go func() {
		defer wg.Done()
		t := time.Now()
		vec, eu, eer = l.llm.EmbedImage(ctx, img.Display)
		ed = time.Since(t)
	}()
	wg.Wait()
	timings["describe"], timings["embed"] = dd.Milliseconds(), ed.Milliseconds()
	l.metrics.Observe("describe", dd)
	l.metrics.Observe("embed", ed)
	if derr != nil {
		l.metrics.Error("describe")
		return nil, derr
	}
	if eer != nil {
		l.metrics.Error("embed")
		return nil, eer
	}
	usage := du
	usage.add(eu)
	l.metrics.Tokens(usage)

	t = time.Now()
	p, err := l.store.Add(ctx, NewPhoto{SHA256: sha, Desc: desc, Author: author, Source: source, Image: img, Embedding: vec})
	if err != nil {
		return nil, err
	}
	timings.lap(l.metrics, "store", t)
	timings["total"] = time.Since(t0).Milliseconds()
	l.metrics.Request("add", "miss")
	return &Added{Photo: p, Timings: timings, Usage: usage}, nil
}

// Results is what a search returns.
type Results struct {
	Query  string  `json:"query,omitempty"`
	Photos []Photo `json:"photos"`
	// Cache: "exact", "semantic" (then Distance and CachedQuery) or "miss".
	Cache       string   `json:"cache"`
	Distance    float64  `json:"distance,omitempty"`
	CachedQuery string   `json:"cachedQuery,omitempty"`
	Library     int64    `json:"library"`
	Site        string   `json:"site"`
	Timings     Timings  `json:"timings"`
	Warnings    []string `json:"warnings,omitempty"`
}

// Search finds photos for a description, through the caches.
func (l *Lens) Search(ctx context.Context, query string, noCache bool) (*Results, error) {
	t0 := time.Now()
	res := &Results{Query: query, Site: l.site, Cache: "miss", Timings: Timings{}}
	version, err := l.store.Version(ctx)
	if err != nil {
		return nil, err
	}
	res.Library = version
	useCache := l.cache != nil && !noCache
	warn := func(stage string, err error) {
		res.Warnings = append(res.Warnings, stage+": "+err.Error())
		l.metrics.Error(stage)
	}
	finish := func() (*Results, error) {
		res.Timings["total"] = time.Since(t0).Milliseconds()
		l.metrics.Request("search", res.Cache)
		l.metrics.Observe("total", time.Since(t0))
		if err := l.store.LogSearch(context.WithoutCancel(ctx), SearchLog{Query: query, Cache: res.Cache,
			Results: len(res.Photos), TotalMs: int(res.Timings["total"]), Site: l.site}); err != nil {
			slog.Debug("search log", "err", err) // read-only in the standby site
		}
		return res, nil
	}
	fromCache := func(hit *CachedSearch, kind string) (*Results, error) {
		photos, err := l.store.ByIDs(ctx, hit.IDs)
		if err != nil {
			return nil, err
		}
		res.Photos, res.Cache = photos, kind
		if kind == "semantic" {
			res.CachedQuery = hit.Query
		}
		return finish()
	}

	if useCache {
		t := time.Now()
		hit, err := l.cache.ExactSearch(ctx, version, query)
		res.Timings.lap(l.metrics, "cache", t)
		if err != nil {
			warn("cache", err)
		} else if hit != nil {
			return fromCache(hit, "exact")
		}
	}

	t := time.Now()
	var vec []float32
	cached := false
	if useCache {
		if vec, cached, err = l.cache.Embedding(ctx, l.llm.embedModel, query); err != nil {
			warn("cache", err)
		}
	}
	if !cached {
		var u Usage
		if vec, u, err = l.llm.EmbedText(ctx, query); err != nil {
			l.metrics.Error("embed")
			return nil, fmt.Errorf("embedding: %w", err)
		}
		l.metrics.Tokens(u)
		if useCache {
			if err := l.cache.PutEmbedding(ctx, l.llm.embedModel, query, vec); err != nil {
				warn("cache", err)
			}
		}
	}
	res.Timings.lap(l.metrics, "embed", t)

	if useCache {
		t := time.Now()
		hit, dist, err := l.cache.SimilarSearch(ctx, version, vec)
		res.Timings.lap(l.metrics, "cache", t)
		if err != nil {
			warn("cache", err)
		} else if hit != nil {
			res.Distance = dist
			return fromCache(hit, "semantic")
		}
	}

	t = time.Now()
	if res.Photos, err = l.store.Search(ctx, vec, query, l.limit, 0); err != nil {
		l.metrics.Error("retrieve")
		return nil, err
	}
	res.Timings.lap(l.metrics, "retrieve", t)

	if useCache {
		ids := make([]int64, len(res.Photos))
		for i, p := range res.Photos {
			ids[i] = p.ID
		}
		t := time.Now()
		if err := l.cache.PutSearch(ctx, version, query, vec, ids); err != nil {
			warn("cache", err)
		}
		res.Timings.lap(l.metrics, "cache", t)
	}
	return finish()
}

// SearchImage finds the photos most like an image, which isn't stored.
func (l *Lens) SearchImage(ctx context.Context, raw []byte) (*Results, error) {
	t0 := time.Now()
	res := &Results{Site: l.site, Cache: "miss", Timings: Timings{}}
	img, err := Prepare(raw)
	if err != nil {
		return nil, err
	}
	t := time.Now()
	vec, u, err := l.llm.EmbedImage(ctx, img.Display)
	if err != nil {
		l.metrics.Error("embed")
		return nil, fmt.Errorf("embedding: %w", err)
	}
	l.metrics.Tokens(u)
	res.Timings.lap(l.metrics, "embed", t)
	t = time.Now()
	if res.Photos, err = l.store.Search(ctx, vec, "", l.limit, 0); err != nil {
		return nil, err
	}
	res.Timings.lap(l.metrics, "retrieve", t)
	res.Timings["total"] = time.Since(t0).Milliseconds()
	l.metrics.Request("image", "miss")
	return res, nil
}

// Similar finds the photos most like one in the library.
func (l *Lens) Similar(ctx context.Context, id int64) (*Results, error) {
	t0 := time.Now()
	res := &Results{Site: l.site, Cache: "miss", Timings: Timings{}}
	vec, err := l.store.Embedding(ctx, id)
	if err != nil {
		return nil, err
	}
	t := time.Now()
	if res.Photos, err = l.store.Search(ctx, vec, "", l.limit, id); err != nil {
		return nil, err
	}
	res.Timings.lap(l.metrics, "retrieve", t)
	res.Timings["total"] = time.Since(t0).Milliseconds()
	l.metrics.Request("similar", "miss")
	return res, nil
}

// Answer is what the vision model says about a photo.
type Answer struct {
	Answer  string  `json:"answer"`
	Cache   string  `json:"cache"`
	Model   string  `json:"model"`
	Timings Timings `json:"timings"`
	Usage   Usage   `json:"usage"`
}

const askSystem = `You answer questions about the photo you are shown. Be concrete and concise: two to four sentences, or a short list. If the photo doesn't show what is asked, say so.`

// Ask asks the vision model about a photo, through the cache.
func (l *Lens) Ask(ctx context.Context, id int64, question string, noCache bool) (*Answer, error) {
	t0 := time.Now()
	timings := Timings{}
	if l.cache != nil && !noCache {
		var hit Answer
		t := time.Now()
		ok, err := l.cache.Answer(ctx, l.llm.visionModel, id, question, &hit)
		timings.lap(l.metrics, "cache", t)
		if err == nil && ok {
			hit.Cache, hit.Usage, hit.Timings = "exact", Usage{}, timings
			timings["total"] = time.Since(t0).Milliseconds()
			l.metrics.Request("ask", "exact")
			return &hit, nil
		}
	}
	img, err := l.store.Image(ctx, id, false)
	if err != nil {
		return nil, err
	}
	t := time.Now()
	text, usage, err := l.llm.Look(ctx, img, askSystem, question, 600)
	if err != nil {
		l.metrics.Error("ask")
		return nil, err
	}
	timings.lap(l.metrics, "generate", t)
	l.metrics.Tokens(usage)
	ans := &Answer{Answer: text, Cache: "miss", Model: l.llm.visionModel, Usage: usage, Timings: timings}
	if l.cache != nil {
		if err := l.cache.PutAnswer(ctx, l.llm.visionModel, id, question, ans); err != nil {
			l.metrics.Error("cache")
		}
	}
	timings["total"] = time.Since(t0).Milliseconds()
	l.metrics.Request("ask", "miss")
	return ans, nil
}

// SeedStatus is how far loading the sample photos is.
type SeedStatus struct {
	Running bool     `json:"running"`
	Done    int      `json:"done"`
	Total   int      `json:"total"`
	Errors  []string `json:"errors,omitempty"`
}

func (l *Lens) SeedStatus() SeedStatus {
	l.seedMu.Lock()
	defer l.seedMu.Unlock()
	s := l.seed
	s.Errors = append([]string(nil), s.Errors...)
	return s
}

type picsum struct {
	ID       string `json:"id"`
	Author   string `json:"author"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	URL      string `json:"url"`
	Download string `json:"download_url"`
}

// Seed loads n sample photos in the background: a random pick of Lorem
// Picsum's (photos from Unsplash, under the Unsplash license), credited to
// their photographers.
func (l *Lens) Seed(n int) error {
	l.seedMu.Lock()
	if l.seed.Running {
		l.seedMu.Unlock()
		return errors.New("already loading sample photos")
	}
	l.seed = SeedStatus{Running: true, Total: n}
	l.seedMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		defer func() { l.seedMu.Lock(); l.seed.Running = false; l.seedMu.Unlock() }()
		fail := func(err error) {
			l.seedMu.Lock()
			l.seed.Errors = append(l.seed.Errors, err.Error())
			l.seedMu.Unlock()
		}
		var list []picsum
		for page := 1; page <= 3; page++ {
			var p []picsum
			if err := l.getJSON(ctx, fmt.Sprintf("https://picsum.photos/v2/list?page=%d&limit=100", page), &p); err != nil {
				fail(fmt.Errorf("sample list: %w", err))
				return
			}
			list = append(list, p...)
		}
		rand.Shuffle(len(list), func(i, j int) { list[i], list[j] = list[j], list[i] })
		list = list[:min(n, len(list))]

		work := make(chan picsum)
		var wg sync.WaitGroup
		for range 3 { // the vision model takes a few seconds per photo
			wg.Add(1)
			go func() {
				defer wg.Done()
				for p := range work {
					h := displaySize * p.Height / max(p.Width, 1)
					raw, err := l.get(ctx, fmt.Sprintf("https://picsum.photos/id/%s/%d/%d", p.ID, displaySize, h))
					if err == nil {
						_, err = l.Add(ctx, raw, p.Author, p.URL)
					}
					if err != nil {
						fail(fmt.Errorf("photo %s: %w", p.ID, err))
					}
					l.seedMu.Lock()
					l.seed.Done++
					l.seedMu.Unlock()
				}
			}()
		}
		for _, p := range list {
			work <- p
		}
		close(work)
		wg.Wait()
		slog.Info("sample photos loaded", "status", l.SeedStatus())
	}()
	return nil
}

func (l *Lens) get(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	rsp, err := l.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer rsp.Body.Close()
	if rsp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", url, rsp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(rsp.Body, 30<<20))
}

func (l *Lens) getJSON(ctx context.Context, url string, into any) error {
	raw, err := l.get(ctx, url)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}
