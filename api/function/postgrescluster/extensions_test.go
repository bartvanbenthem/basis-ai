package postgrescluster

import (
	"encoding/json"
	"strings"
	"testing"

	"sigs.k8s.io/yaml"
)

// The extensions catalog as apis/postgrescluster/extensions.yaml has it:
// vector ships with the image, vchord and pg_search are mounted from images.
const extensionsCatalog = `data: {extensions: [
  {name: vector},
  {name: vchord, requires: [vector], sharedPreloadLibraries: [vchord],
   image: {reference: ghcr.io/tensorchord/vchord-scratch:pg18},
   extensionControlPath: [usr/share/postgresql/18], dynamicLibraryPath: [usr/lib/postgresql/18/lib]},
  {name: pg_search, requires: [vector], sharedPreloadLibraries: [pg_search],
   image: {reference: paradedb/paradedb-extension:18-trixie}, ldLibraryPath: [system]}]}`

const sizesCatalog = `data: {sizes: [{name: m, resources: {requests: {cpu: 2, memory: 8Gi}},
  parameters: {maintenance_work_mem: 512MB, work_mem: 16MB},
  profiles: {vector: {parameters: {maintenance_work_mem: 2GB, max_parallel_maintenance_workers: 2}}}}]}`

func composeVector(t *testing.T, spec string, observed map[string]Object, required map[string][]Object) *Output {
	t.Helper()
	x := obj(t, xrYAML)
	x["spec"] = obj(t, spec)
	if required == nil {
		required = map[string][]Object{
			RequiredSizes:      {obj(t, sizesCatalog)},
			RequiredExtensions: {obj(t, extensionsCatalog)},
		}
	}
	required[RequiredProject] = project(t, "spec: {locations: {protected: "+rtm+"}}")
	out, err := Compose(Input{XR: x, Observed: observed, Required: required})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// queries is the custom exporter queries ConfigMap's content.
func queries(t *testing.T, out *Output) string {
	t.Helper()
	q, _ := dig(toObject(out.Composed["monitoring-queries"].Object), "spec", "forProvider", "manifest", "data", "queries").(string)
	return q
}

func asJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestImageExtensions(t *testing.T) {
	out := composeVector(t, `
postgresVersion: 18
postgresql: {sharedPreloadLibraries: [pg_stat_statements]}
database: {extensions: [vector, vchord, pg_search]}`, nil, nil)
	pg := dig(clusterSpec(t, out, "cluster"), "postgresql")
	if got, want := asJSON(dig(pg, "shared_preload_libraries")), `["pg_stat_statements","vchord","pg_search"]`; got != want {
		t.Errorf("shared_preload_libraries %s, want %s", got, want)
	}
	want := `[{"dynamic_library_path":["usr/lib/postgresql/18/lib"],"extension_control_path":["usr/share/postgresql/18"],` +
		`"image":{"reference":"ghcr.io/tensorchord/vchord-scratch:pg18"},"name":"vchord"},` +
		`{"image":{"reference":"paradedb/paradedb-extension:18-trixie"},"ld_library_path":["system"],"name":"pg_search"}]`
	if got := asJSON(dig(pg, "extensions")); got != want {
		t.Errorf("extensions %s, want %s", got, want)
	}
	if strings.Contains(out.Status.Message, "postgresVersion") {
		t.Errorf("unexpected problem: %s", out.Status.Message)
	}
}

func TestImageExtensionsNeedPostgres18(t *testing.T) {
	out := composeVector(t, `
postgresVersion: 17
database: {extensions: [vector, vchord]}`, nil, nil)
	pg := dig(clusterSpec(t, out, "cluster"), "postgresql")
	if dig(pg, "extensions") != nil || dig(pg, "shared_preload_libraries") != nil {
		t.Errorf("image extension mounted into PostgreSQL 17: %s", asJSON(pg))
	}
	if !strings.Contains(out.Status.Message, "needs postgresVersion 18") {
		t.Errorf("status.message %q", out.Status.Message)
	}
}

// A running cluster keeps what it mounts and preloads while the catalog
// can't say how: dropping a preloaded library's image stops PostgreSQL.
func TestImageExtensionsKeptWithoutCatalog(t *testing.T) {
	observed := running(t)
	var manifest Object
	if err := yaml.Unmarshal([]byte(`
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
spec:
  postgresql:
    shared_preload_libraries: [vchord, auto_explain]
    extensions: [{name: vchord, image: {reference: ghcr.io/tensorchord/vchord-scratch:pg18}}]`), &manifest); err != nil {
		t.Fatal(err)
	}
	observed["cluster"] = Object{"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
		"status": Object{"atProvider": Object{"manifest": manifest}}}
	out := composeVector(t, `
postgresVersion: 18
database: {extensions: [vector, vchord]}`, observed, map[string][]Object{RequiredExtensions: {}})
	pg := dig(clusterSpec(t, out, "cluster"), "postgresql")
	if got, want := asJSON(dig(pg, "extensions")), `[{"image":{"reference":"ghcr.io/tensorchord/vchord-scratch:pg18"},"name":"vchord"}]`; got != want {
		t.Errorf("extensions %s, want %s", got, want)
	}
	if got, want := asJSON(dig(pg, "shared_preload_libraries")), `["vchord","auto_explain"]`; got != want {
		t.Errorf("shared_preload_libraries %s, want %s", got, want)
	}
}

func TestVectorProfile(t *testing.T) {
	out := composeVector(t, `
profile: vector
postgresVersion: 18
size: m
postgresql: {parameters: {work_mem: 32MB}}
database: {extensions: [vector]}`, nil, nil)
	got := asJSON(dig(clusterSpec(t, out, "cluster"), "postgresql", "parameters"))
	// The profile's settings over the size's, the spec's over both.
	if want := `{"maintenance_work_mem":"2GB","max_parallel_maintenance_workers":"2","work_mem":"32MB"}`; got != want {
		t.Errorf("parameters %s, want %s", got, want)
	}
	if s := out.Status.Sizing; s == nil || s.Profile != ProfileVector {
		t.Errorf("status.sizing %+v", s)
	}
	if q := queries(t, out); !strings.Contains(q, "vector_index:") || !strings.Contains(q, "wal_archive:") {
		t.Errorf("vector cluster's queries: %.200s", q)
	}

	general := composeVector(t, "size: m", nil, nil)
	if got := asJSON(dig(clusterSpec(t, general, "cluster"), "postgresql", "parameters", "maintenance_work_mem")); got != `"512MB"` {
		t.Errorf("general profile maintenance_work_mem %s", got)
	}
	if q := queries(t, general); q == "" || strings.Contains(q, "vector_index") {
		t.Errorf("general cluster exports vector queries")
	}
}

func TestVectorQueriesParse(t *testing.T) {
	var q map[string]struct {
		Query           string           `json:"query"`
		TargetDatabases []string         `json:"target_databases"`
		Metrics         []map[string]any `json:"metrics"`
	}
	if err := yaml.Unmarshal([]byte(queriesFor(ProfileVector)), &q); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"wal_archive", "vector_index", "create_index_progress"} {
		if q[name].Query == "" || len(q[name].Metrics) == 0 {
			t.Errorf("query %s missing", name)
		}
	}
}

// CNPG creates a Database's extensions in order, without CASCADE: what one
// requires comes first, added if the spec leaves it out.
func TestExtensionOrder(t *testing.T) {
	out := composeVector(t, `
postgresVersion: 18
database: {name: docs, extensions: [pg_search, pg_trgm, vchord]}`, nil, nil)
	o := toObject(out.Composed["database-docs"].Object)
	var names []string
	for _, e := range dig(o, "spec", "forProvider", "manifest", "spec", "extensions").([]any) {
		names = append(names, e.(map[string]any)["name"].(string))
	}
	if got, want := strings.Join(names, ","), "vector,pg_search,pg_trgm,vchord"; got != want {
		t.Errorf("extensions %s, want %s", got, want)
	}
}
