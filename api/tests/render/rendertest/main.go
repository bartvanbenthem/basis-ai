// Command rendertest holds the Go parts of tests/render/run.sh:
//
//	rendertest crds <helm-template-output.yaml> <out.yaml>
//	    keep only the CustomResourceDefinitions (the Barman Cloud chart ships them with the plugin)
//	rendertest objects <render-output.yaml> <out.yaml>
//	    the objects to schema-validate: no Function Results, no core kinds, plus
//	    the manifest inside every provider-kubernetes Object
//	rendertest assert <api> <case> <empty|observed> <render-output.yaml> [dashboard.json]
//	    semantic assertions on `crossplane render` output (postgrescluster.go, project.go, location.go, valkeycache.go,
//	    modelserver.go, modelgateway.go, genaistack.go)
package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/bartvanbenthem/basis-ai/api/internal/doc"
)

type (
	M = doc.M
	L = doc.L
)

var (
	get   = doc.Get
	str   = doc.Str
	mp    = doc.Map
	list  = doc.List
	has   = doc.Has
	equal = doc.Equal
	repr  = doc.Repr
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage: rendertest crds <in.yaml> <out.yaml>
       rendertest objects <render.yaml> <out.yaml>
       rendertest stores <render.yaml> <observed-out.yaml>
       rendertest assert <api> <case> <empty|observed|stores> <render.yaml> [dashboard.json]`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch args := os.Args[2:]; os.Args[1] {
	case "crds":
		if len(args) != 2 {
			usage()
		}
		err = filterDocs(args[0], args[1], func(d M) []M {
			if str(d, "kind") == "CustomResourceDefinition" {
				return []M{d}
			}
			return nil
		})
	case "objects":
		if len(args) != 2 {
			usage()
		}
		core := map[string]bool{"v1": true, "rbac.authorization.k8s.io/v1": true, "networking.k8s.io/v1": true,
			"apiregistration.k8s.io/v1": true, "batch/v1": true}
		var manifests []M
		err = filterDocs(args[0], args[1], func(d M) []M {
			if str(d, "kind") == "Result" {
				return nil
			}
			var out []M
			if !core[str(d, "apiVersion")] {
				out = append(out, d)
			}
			// Manifests come after all composed objects, as in the render output order.
			if m := mp(d, "spec", "forProvider", "manifest"); str(d, "kind") == "Object" && m != nil &&
				!core[str(m, "apiVersion")] {
				manifests = append(manifests, m)
			}
			return out
		}, func() []M { return manifests })
	case "stores":
		// The observed state in which every composed ObjectStore is reported
		// by its location: what a Cluster waits for (see postgrescluster.go).
		if len(args) != 2 {
			usage()
		}
		err = filterDocs(args[0], args[1], func(d M) []M {
			m := mp(d, "spec", "forProvider", "manifest")
			if str(d, "kind") != "Object" || str(m, "kind") != "ObjectStore" {
				return nil
			}
			return []M{{"apiVersion": str(d, "apiVersion"), "kind": "Object", "metadata": d["metadata"],
				"spec": d["spec"], "status": M{"atProvider": M{"manifest": m}}}}
		})
	case "assert":
		if len(args) < 4 {
			usage()
		}
		os.Exit(assert(args[0], args[1], args[2], args[3], args[4:]))
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// filterDocs writes keep(d) for every document of in, then whatever the
// optional tail functions return.
func filterDocs(in, out string, keep func(M) []M, tail ...func() []M) error {
	docs, err := doc.LoadAll(in)
	if err != nil {
		return fmt.Errorf("%s: %w", in, err)
	}
	var result []M
	for _, d := range docs {
		result = append(result, keep(d)...)
	}
	for _, t := range tail {
		result = append(result, t()...)
	}
	if len(result) == 0 {
		// An encoder that wrote nothing can't be closed: an empty file.
		return os.WriteFile(out, nil, 0o644)
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	for _, d := range result {
		if err := enc.Encode(d); err != nil {
			return err
		}
	}
	if err := enc.Close(); err != nil {
		return err
	}
	return os.WriteFile(out, buf.Bytes(), 0o644)
}

// --- assertions

// render is one `crossplane render` output: the XR and its composed resources.
type render struct {
	kase, state string
	xr          M
	composed    map[string]M // by composition-resource-name
	status      M
	conds       map[string]M // XR status conditions by type
	name, ns    string
	errors      []string
}

func loadRender(kase, state, path, xrKind string) (*render, error) {
	docs, err := doc.LoadAll(path)
	if err != nil {
		return nil, err
	}
	r := &render{kase: kase, state: state, composed: map[string]M{}, conds: map[string]M{}}
	for _, d := range docs {
		switch str(d, "kind") {
		case xrKind:
			r.xr = d
		case "Result":
		default:
			r.composed[str(d, "metadata", "annotations", "crossplane.io/composition-resource-name")] = d
		}
	}
	if r.xr == nil {
		return nil, fmt.Errorf("%s: no %s in the render output", path, xrKind)
	}
	// The shape every assertion relies on; a real render always has it.
	if mp(r.xr, "spec") == nil || mp(r.xr, "metadata") == nil {
		return nil, fmt.Errorf("%s: %s without spec or metadata", path, xrKind)
	}
	for key, d := range r.composed {
		if str(d, "kind") == "" || mp(d, "metadata") == nil {
			return nil, fmt.Errorf("%s: composed resource %q without kind or metadata", path, key)
		}
		if str(d, "kind") == "Object" {
			if m := mp(d, "spec", "forProvider", "manifest"); str(m, "kind") == "" || mp(m, "metadata") == nil {
				return nil, fmt.Errorf("%s: Object %q without a manifest kind or metadata", path, key)
			}
		}
	}
	r.status = mp(r.xr, "status")
	for _, c := range list(r.status, "conditions") {
		if str(c, "type") == "" {
			r.check(false, "status condition without a type: %s", repr(c))
		}
		r.conds[str(c, "type")] = mp(c)
	}
	r.name, r.ns = str(r.xr, "metadata", "name"), str(r.xr, "metadata", "namespace")
	return r, nil
}

func (r *render) check(ok bool, format string, args ...any) {
	if !ok {
		r.errors = append(r.errors, fmt.Sprintf(format, args...))
	}
}

// live is the object a composed resource stands for: an Object's manifest, or itself.
func (r *render) live(key string) M {
	obj := r.composed[key]
	if str(obj, "kind") == "Object" {
		return mp(obj, "spec", "forProvider", "manifest")
	}
	return obj
}

func (r *render) keys() []string { return sortedKeys(r.composed) }

// report prints the result and returns the exit code.
func (r *render) report(failHeader, okLine string) int {
	if len(r.errors) > 0 {
		fmt.Println(failHeader)
		for _, e := range r.errors {
			fmt.Printf("  - %s\n", e)
		}
		return 1
	}
	fmt.Println(okLine)
	return 0
}

func assert(api, kase, state, path string, rest []string) int {
	var (
		r   *render
		err error
	)
	switch api {
	case "postgrescluster":
		if len(rest) != 1 {
			usage()
		}
		if r, err = loadRender(kase, state, path, "PostgresCluster"); err == nil {
			assertPostgresCluster(r, rest[0])
			return r.report(fmt.Sprintf("FAIL %s/%s:", kase, state),
				fmt.Sprintf("OK %s/%s: %d composed resources", kase, state, len(r.composed)))
		}
	case "project":
		if r, err = loadRender(kase, state, path, "Project"); err == nil {
			assertProject(r)
			return r.report(fmt.Sprintf("FAIL project %s/%s:", kase, state),
				fmt.Sprintf("OK project %s/%s: %d composed resources", kase, state, len(r.composed)))
		}
	case "location":
		if r, err = loadRender(kase, state, path, "Location"); err == nil {
			assertLocation(r)
			return r.report(fmt.Sprintf("FAIL location/%s (%s):", kase, state),
				fmt.Sprintf("ok   location/%s (%s)", kase, state))
		}
	case "genaistack":
		if r, err = loadRender(kase, state, path, "GenAIStack"); err == nil {
			assertGenAIStack(r)
			return r.report(fmt.Sprintf("FAIL genaistack/%s (%s):", kase, state),
				fmt.Sprintf("ok   genaistack/%s (%s)", kase, state))
		}
	case "modelgateway":
		if r, err = loadRender(kase, state, path, "ModelGateway"); err == nil {
			assertModelGateway(r)
			return r.report(fmt.Sprintf("FAIL modelgateway/%s (%s):", kase, state),
				fmt.Sprintf("ok   modelgateway/%s (%s)", kase, state))
		}
	case "modelserver":
		if r, err = loadRender(kase, state, path, "ModelServer"); err == nil {
			assertModelServer(r)
			return r.report(fmt.Sprintf("FAIL modelserver/%s (%s):", kase, state),
				fmt.Sprintf("ok   modelserver/%s (%s)", kase, state))
		}
	case "valkeycache":
		if r, err = loadRender(kase, state, path, "ValkeyCache"); err == nil {
			assertValkeyCache(r)
			return r.report(fmt.Sprintf("FAIL valkeycache/%s (%s):", kase, state),
				fmt.Sprintf("ok   valkeycache/%s (%s)", kase, state))
		}
	default:
		fmt.Fprintf(os.Stderr, "no assertions for API %q\n", api)
		return 2
	}
	fmt.Fprintln(os.Stderr, err)
	return 1
}

// --- small helpers

// set builds a string set.
func set(items ...string) map[string]bool {
	s := make(map[string]bool, len(items))
	for _, i := range items {
		s[i] = true
	}
	return s
}

// union merges string sets.
func union(sets ...map[string]bool) map[string]bool {
	u := map[string]bool{}
	for _, s := range sets {
		for k := range s {
			u[k] = true
		}
	}
	return u
}

// prefixed returns {prefix+k} for every k in s.
func prefixed(prefix string, s map[string]bool) map[string]bool {
	p := make(map[string]bool, len(s))
	for k := range s {
		p[prefix+k] = true
	}
	return p
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sameKeys[V any](m map[string]V, want map[string]bool) bool {
	if len(m) != len(want) {
		return false
	}
	for k := range m {
		if !want[k] {
			return false
		}
	}
	return true
}

// strs reads a sequence of strings.
func strs(v any) []string {
	var out []string
	for _, e := range doc.List(v) {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// strings collects every key and string value under v, for text searches.
func allStrings(v any) string {
	var b strings.Builder
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case M:
			for _, k := range sortedKeys(x) {
				b.WriteString(k + "\n")
				walk(x[k])
			}
		case L:
			for _, e := range x {
				walk(e)
			}
		case string:
			b.WriteString(x + "\n")
		}
	}
	walk(v)
	return b.String()
}

// root is the api directory.
func root() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(file))))
}
