// Package doc reads Kubernetes-style YAML into plain Go values
// (map[string]any, []any, string, int, float64, bool) and walks them
// without type assertions at every step: a missing key or a value of the
// wrong type reads as nil, like Python's dict.get.
package doc

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"sort"

	"gopkg.in/yaml.v3"
)

// M is a decoded YAML mapping.
type M = map[string]any

// L is a decoded YAML sequence.
type L = []any

// LoadAll decodes every non-empty document of a multi-document YAML file.
func LoadAll(path string) ([]M, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return DecodeAll(raw)
}

// DecodeAll decodes every non-empty document of multi-document YAML.
func DecodeAll(raw []byte) ([]M, error) {
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	var docs []M
	for {
		var d M
		err := dec.Decode(&d)
		if errors.Is(err, io.EOF) {
			return docs, nil
		}
		if err != nil {
			return nil, err
		}
		if d != nil {
			docs = append(docs, d)
		}
	}
}

// Load decodes a single YAML (or JSON) document.
func Load(path string) (any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var v any
	if err := yaml.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return v, nil
}

// Get follows a path of mapping keys (string) and sequence indexes (int).
// It returns nil as soon as a step does not exist.
func Get(v any, path ...any) any {
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, ok := v.(M)
			if !ok {
				return nil
			}
			v = m[k]
		case int:
			l, ok := v.(L)
			if !ok || k < 0 || k >= len(l) {
				return nil
			}
			v = l[k]
		default:
			panic(fmt.Sprintf("doc.Get: bad path element %T", p))
		}
	}
	return v
}

// Has reports whether the mapping at path has key.
func Has(v any, key string, path ...any) bool {
	m, ok := Get(v, path...).(M)
	if !ok {
		return false
	}
	_, ok = m[key]
	return ok
}

// Map is Get for a mapping; nil (still readable) when absent.
func Map(v any, path ...any) M {
	m, _ := Get(v, path...).(M)
	return m
}

// List is Get for a sequence; nil when absent.
func List(v any, path ...any) L {
	l, _ := Get(v, path...).(L)
	return l
}

// Str is Get for a string; "" when absent.
func Str(v any, path ...any) string {
	s, _ := Get(v, path...).(string)
	return s
}

// Keys returns a mapping's keys, sorted.
func Keys(m M) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Equal compares decoded values structurally. Numbers compare by value
// (YAML 2 equals 2.0), maps and slices element-wise, nil only equals nil.
func Equal(a, b any) bool {
	a, b = normalize(a), normalize(b)
	if fa, ok := a.(float64); ok {
		fb, ok := b.(float64)
		return ok && fa == fb
	}
	switch av := a.(type) {
	case M:
		bv, ok := b.(M)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, x := range av {
			y, ok := bv[k]
			if !ok || !Equal(x, y) {
				return false
			}
		}
		return true
	case L:
		bv, ok := b.(L)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !Equal(av[i], bv[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

// normalize turns every number into float64 and typed slices/maps built in
// Go code ([]string, map[string]string, ...) into L and M.
func normalize(v any) any {
	switch x := v.(type) {
	case nil, M, L, string, bool, float64:
		return v
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	case float32:
		return float64(x)
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice:
		l := make(L, rv.Len())
		for i := range l {
			l[i] = rv.Index(i).Interface()
		}
		return l
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			return v
		}
		m := make(M, rv.Len())
		for _, k := range rv.MapKeys() {
			m[k.String()] = rv.MapIndex(k).Interface()
		}
		return m
	}
	return v
}

// IsInt reports whether v is an integer (and not a float that happens to be whole).
func IsInt(v any) bool {
	switch v.(type) {
	case int, int64, uint64:
		return true
	}
	return false
}

// Repr renders a value compactly for failure messages.
func Repr(v any) string {
	if v == nil {
		return "None"
	}
	if s, ok := v.(string); ok {
		return fmt.Sprintf("%q", s)
	}
	out, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(out)
}
