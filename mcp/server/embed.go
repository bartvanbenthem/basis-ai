package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Embedder turns texts into vectors.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
}

// OpenAIEmbedder calls an OpenAI-compatible /embeddings endpoint: the
// Project's ModelGateway, with the server's own client key there.
type OpenAIEmbedder struct {
	BaseURL, APIKey, Model string
	// Dimensions, when set, is sent along (models that can shorten).
	Dimensions int
	HTTP       *http.Client
	// Observe, when set, is told how each call went.
	Observe func(outcome string, d time.Duration)
}

// maxBatch: what the server sends in one request at most.
const maxBatch = 64

func (e *OpenAIEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += maxBatch {
		batch := texts[start:min(start+maxBatch, len(texts))]
		vecs, err := e.embed(ctx, batch)
		if err != nil {
			return nil, err
		}
		out = append(out, vecs...)
	}
	return out, nil
}

func (e *OpenAIEmbedder) embed(ctx context.Context, texts []string) (vecs [][]float32, err error) {
	started := time.Now()
	defer func() {
		if e.Observe != nil {
			outcome := "ok"
			if err != nil {
				outcome = "error"
			}
			e.Observe(outcome, time.Since(started))
		}
	}()
	body := map[string]any{"model": e.Model, "input": texts, "encoding_format": "float"}
	if e.Dimensions > 0 {
		body["dimensions"] = e.Dimensions
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(e.BaseURL, "/")+"/embeddings", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if e.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+e.APIKey)
	}
	client := e.HTTP
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embeddings: %w", err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return nil, fmt.Errorf("embeddings: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("embeddings: model %s answered %d: %s", e.Model, resp.StatusCode, truncate(string(payload), 300))
	}
	var parsed struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, fmt.Errorf("embeddings: %w", err)
	}
	if len(parsed.Data) != len(texts) {
		return nil, fmt.Errorf("embeddings: %d vectors for %d texts", len(parsed.Data), len(texts))
	}
	vecs = make([][]float32, len(texts))
	for _, d := range parsed.Data {
		if d.Index < 0 || d.Index >= len(texts) || len(d.Embedding) == 0 {
			return nil, fmt.Errorf("embeddings: a vector without a valid index")
		}
		vecs[d.Index] = d.Embedding
	}
	return vecs, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
