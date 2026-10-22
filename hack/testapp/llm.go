package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// LLM talks to the stack's ModelGateway: OpenAI's chat and embeddings APIs,
// with the stack's client key. The gateway routes on the model name.
type LLM struct {
	base, key, visionModel, embedModel string
	dim                                int
	http                               *http.Client
}

// Usage is what a call cost in tokens.
type Usage struct {
	Prompt     int `json:"prompt"`
	Completion int `json:"completion"`
}

func (u *Usage) add(o Usage) { u.Prompt += o.Prompt; u.Completion += o.Completion }

func (l *LLM) post(ctx context.Context, path string, body, into any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(l.base, "/")+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+l.key)
	rsp, err := l.http.Do(req)
	if err != nil {
		return err
	}
	defer rsp.Body.Close()
	data, err := io.ReadAll(rsp.Body)
	if err != nil {
		return err
	}
	if rsp.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway %s: HTTP %d: %.300s", path, rsp.StatusCode, data)
	}
	return json.Unmarshal(data, into)
}

type embeddingResponse struct {
	Data []struct {
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Usage struct {
		PromptTokens int `json:"prompt_tokens"`
	} `json:"usage"`
}

func (r *embeddingResponse) first() ([]float32, Usage, error) {
	if len(r.Data) == 0 {
		return nil, Usage{}, fmt.Errorf("gateway /embeddings: no vector")
	}
	return r.Data[0].Embedding, Usage{Prompt: r.Usage.PromptTokens}, nil
}

// EmbedText embeds a search query. Qwen3-VL-Embedding puts text and images
// in one space, so a text vector finds the images it describes. It is
// Matryoshka-trained: dimensions shortens the vector and keeps it useful.
func (l *LLM) EmbedText(ctx context.Context, text string) ([]float32, Usage, error) {
	var rsp embeddingResponse
	if err := l.post(ctx, "/embeddings", map[string]any{"model": l.embedModel, "input": text, "dimensions": l.dim}, &rsp); err != nil {
		return nil, Usage{}, err
	}
	return rsp.first()
}

// EmbedImage embeds a JPEG: vLLM takes images in a chat-style messages
// field on /v1/embeddings, which the gateway passes through.
func (l *LLM) EmbedImage(ctx context.Context, jpeg []byte) ([]float32, Usage, error) {
	var rsp embeddingResponse
	body := map[string]any{"model": l.embedModel, "dimensions": l.dim, "encoding_format": "float",
		"messages": []any{map[string]any{"role": "user", "content": []any{imagePart(jpeg), map[string]any{"type": "text", "text": ""}}}}}
	if err := l.post(ctx, "/embeddings", body, &rsp); err != nil {
		return nil, Usage{}, err
	}
	return rsp.first()
}

func imagePart(jpeg []byte) map[string]any {
	return map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(jpeg)}}
}

// Look asks the vision model about an image.
func (l *LLM) Look(ctx context.Context, jpeg []byte, system, prompt string, maxTokens int) (string, Usage, error) {
	var rsp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	body := map[string]any{"model": l.visionModel, "max_tokens": maxTokens, "temperature": 0.2, "messages": []any{
		map[string]any{"role": "system", "content": system},
		map[string]any{"role": "user", "content": []any{imagePart(jpeg), map[string]any{"type": "text", "text": prompt}}},
	}}
	if err := l.post(ctx, "/chat/completions", body, &rsp); err != nil {
		return "", Usage{}, err
	}
	usage := Usage{Prompt: rsp.Usage.PromptTokens, Completion: rsp.Usage.CompletionTokens}
	if len(rsp.Choices) == 0 || strings.TrimSpace(rsp.Choices[0].Message.Content) == "" {
		return "", usage, fmt.Errorf("gateway /chat/completions: empty answer")
	}
	return strings.TrimSpace(rsp.Choices[0].Message.Content), usage, nil
}

// Description is what the vision model says about a photo.
type Description struct {
	Title   string   `json:"title"`
	Caption string   `json:"caption"`
	Tags    []string `json:"tags"`
}

const describePrompt = `Describe this photo for a searchable photo library. Reply with JSON only, no code fence:
{"title": "3 to 6 words", "caption": "one or two sentences: the subject, the setting, notable colors, mood and light", "tags": ["8 to 12 lowercase single- or two-word tags: objects, scene, colors, style"]}`

// Describe captions and tags a photo.
func (l *LLM) Describe(ctx context.Context, jpeg []byte) (Description, Usage, error) {
	text, usage, err := l.Look(ctx, jpeg, "You write accurate, concrete descriptions of photos.", describePrompt, 400)
	if err != nil {
		return Description{}, usage, err
	}
	d, err := parseDescription(text)
	return d, usage, err
}

// parseDescription takes the JSON object out of a reply that may wrap it in
// a code fence or a sentence.
func parseDescription(text string) (Description, error) {
	var d Description
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return d, fmt.Errorf("vision model: no JSON in %.120q", text)
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &d); err != nil {
		return d, fmt.Errorf("vision model: %w in %.120q", err, text)
	}
	tags := d.Tags[:0]
	seen := map[string]bool{}
	for _, t := range d.Tags {
		t = strings.ToLower(strings.TrimSpace(t))
		if t != "" && !seen[t] {
			seen[t] = true
			tags = append(tags, t)
		}
	}
	d.Tags = tags
	if d.Caption == "" {
		return d, fmt.Errorf("vision model: no caption in %.120q", text)
	}
	return d, nil
}

// Ping checks the gateway and the key: the models it serves.
func (l *LLM) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(l.base, "/")+"/models", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+l.key)
	rsp, err := l.http.Do(req)
	if err != nil {
		return err
	}
	defer rsp.Body.Close()
	if rsp.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway /models: HTTP %d", rsp.StatusCode)
	}
	return nil
}
