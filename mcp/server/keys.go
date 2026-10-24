package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
)

// Keys are the clients' API keys: the files of a mounted Secret, one per
// client (the file name is the client). The kubelet updates the files when
// the Secret changes, so they're read again every interval: a removed or
// expired client's key stops working without a restart.
type Keys struct {
	dir string

	mu sync.RWMutex
	// byHash: sha256 of a key -> its client, so a lookup doesn't depend on
	// the key's bytes (compared in constant time below).
	byHash map[[32]byte]string
}

// NewKeys reads dir once; Watch keeps it current.
func NewKeys(dir string) (*Keys, error) {
	k := &Keys{dir: dir}
	return k, k.reload()
}

func (k *Keys) reload() error {
	entries, err := os.ReadDir(k.dir)
	if err != nil {
		return err
	}
	byHash := map[[32]byte]string{}
	for _, e := range entries {
		// A Secret volume's own entries (..data, ..2026_...) start with a dot.
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(k.dir, e.Name()))
		if err != nil || e.IsDir() {
			continue
		}
		if key := strings.TrimSpace(string(raw)); key != "" {
			byHash[sha256.Sum256([]byte(key))] = e.Name()
		}
	}
	k.mu.Lock()
	k.byHash = byHash
	k.mu.Unlock()
	return nil
}

// Watch reloads the keys every interval until ctx ends.
func (k *Keys) Watch(ctx context.Context, interval time.Duration, onError func(error)) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := k.reload(); err != nil && onError != nil {
				onError(err)
			}
		}
	}
}

// Client is the client a key belongs to, "" for none.
func (k *Keys) Client(key string) string {
	h := sha256.Sum256([]byte(key))
	k.mu.RLock()
	defer k.mu.RUnlock()
	for known, client := range k.byHash {
		if subtle.ConstantTimeCompare(known[:], h[:]) == 1 {
			return client
		}
	}
	return ""
}

// Len is the number of clients with a key.
func (k *Keys) Len() int {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return len(k.byHash)
}

// Verifier checks a bearer token against the keys: the token info's UserID
// is the client.
func (k *Keys) Verifier() auth.TokenVerifier {
	return func(_ context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
		client := k.Client(token)
		if client == "" {
			return nil, auth.ErrInvalidToken
		}
		return &auth.TokenInfo{UserID: client}, nil
	}
}
