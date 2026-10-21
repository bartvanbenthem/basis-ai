package postgrescluster

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"sigs.k8s.io/yaml"
)

// The render tests (tests/render) cover the composition end to end; these
// cover what they can't: the refusals, and the details the fixtures don't vary.

func obj(t *testing.T, y string) Object {
	t.Helper()
	var o Object
	if err := yaml.Unmarshal([]byte(y), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

const xrYAML = `
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata: {name: orders-db, namespace: payments, uid: 0f3a9c1e-1111-2222-3333-444444444444}
spec: {}
`

func project(t *testing.T, y string) []Object {
	return []Object{obj(t, "apiVersion: platform.cndev.nl/v1alpha1\nkind: Project\nmetadata: {name: payments}\n"+y)}
}

// running is the observed state of a cluster that exists: the dashboard and its Cluster.
func running(t *testing.T) map[string]Object {
	return map[string]Object{
		"dashboard": obj(t, "apiVersion: grafana.integreatly.org/v1beta1\nkind: GrafanaDashboard"),
		"cluster":   obj(t, "apiVersion: kubernetes.m.crossplane.io/v1alpha1\nkind: Object"),
	}
}

func TestComposeRefuses(t *testing.T) {
	withSpec := func(spec string) Object {
		x := obj(t, xrYAML)
		x["spec"] = obj(t, spec)
		return x
	}
	cases := map[string]struct {
		in   Input
		want string // "" = no refusal
	}{
		"no site for a running cluster": {
			in:   Input{XR: obj(t, xrYAML), Observed: running(t), Required: map[string][]Object{RequiredProject: {}}},
			want: "has composed resources but no site",
		},
		"no site yet, Project not resolved": {
			in: Input{XR: obj(t, xrYAML), Observed: running(t), Required: map[string][]Object{}},
		},
		"no site for a new cluster is a problem, not a refusal": {
			in: Input{XR: obj(t, xrYAML), Required: map[string][]Object{RequiredProject: {}}},
		},
		"Project bucket gone for a running cluster": {
			in: Input{XR: withSpec("backup: {enabled: true}"), Observed: running(t),
				Required: map[string][]Object{RequiredProject: project(t, "spec: {locations: {protected: "+rtm+"}}")}},
			want: "uses the Project's backup bucket",
		},
		"size gone from the catalog with nothing pinned": {
			in: Input{XR: withSpec("size: huge"), Observed: running(t),
				Required: map[string][]Object{
					RequiredProject: project(t, "spec: {locations: {protected: "+rtm+"}}"),
					RequiredSizes:   {obj(t, "data: {sizes: [{name: s}]}")},
				}},
			want: "is not in the postgres-sizes catalog, and no status.sizing",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			out, err := Compose(tc.in)
			var stop *Stop
			switch {
			case tc.want == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tc.want == "":
				// A new or unplaced cluster: only the dashboard, never a
				// Cluster without a location.
				if _, ok := out.Composed["cluster"]; ok {
					t.Errorf("composed a Cluster without a site")
				}
			case !errors.As(err, &stop) || !strings.Contains(err.Error(), tc.want):
				t.Fatalf("error %v, want a refusal containing %q", err, tc.want)
			}
		})
	}
}

func clusterSpec(t *testing.T, out *Output, key string) map[string]any {
	t.Helper()
	c, ok := out.Composed[key]
	if !ok {
		t.Fatalf("no %s composed", key)
	}
	o := toObject(c.Object)
	spec, _ := dig(o, "spec", "forProvider", "manifest", "spec").(map[string]any)
	return spec
}

func TestParameterPrecedence(t *testing.T) {
	x := obj(t, xrYAML)
	x["spec"] = obj(t, `
size: m
postgresql: {parameters: {work_mem: 64MB, empty: ""}}
database: {extensions: [pg_stat_statements]}`)
	out, err := Compose(Input{XR: x, Required: map[string][]Object{
		RequiredProject: project(t, "spec: {locations: {protected: "+rtm+"}}"),
		RequiredSizes: {obj(t, `data: {sizes: [{name: m, resources: {requests: {cpu: 2, memory: 8Gi}},
  parameters: {work_mem: 16MB, shared_buffers: 2GB, max_connections: 200, empty: from-size}}]}`)},
		RequiredExtensions: {obj(t, `data: {extensions: [
  {name: pg_stat_statements, parameters: {pg_stat_statements.track: top, shared_buffers: 1GB}},
  {name: pg_trgm, parameters: {never: used}}]}`)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	spec := clusterSpec(t, out, "cluster")
	got, _ := json.Marshal(dig(spec, "postgresql", "parameters"))
	// The spec's settings over the size's over the extensions'; an empty one
	// counts as unset; numbers from the catalog become strings.
	want := `{"empty":"from-size","max_connections":"200","pg_stat_statements.track":"top","shared_buffers":"2GB","work_mem":"64MB"}`
	if string(got) != want {
		t.Errorf("parameters %s, want %s", got, want)
	}
	res, _ := json.Marshal(spec["resources"])
	if want := `{"limits":{"memory":"1Gi"},"requests":{"cpu":"2","memory":"8Gi"}}`; string(res) != want {
		t.Errorf("resources %s, want %s", res, want)
	}
	if out.Status.Sizing == nil || out.Status.Sizing.Size != "m" {
		t.Errorf("status.sizing %+v", out.Status.Sizing)
	}
}

func TestPromotionReloadMarker(t *testing.T) {
	x := obj(t, xrYAML)
	x["spec"] = obj(t, "backup: {enabled: true, destinationPath: s3://b/p, s3Credentials: {secretName: s3}}\ngeoReplication: {enabled: true}")
	observed := running(t)
	observed["recovery-cluster"] = obj(t, `
apiVersion: kubernetes.m.crossplane.io/v1alpha1
kind: Object
status: {atProvider: {manifest: {apiVersion: postgresql.cnpg.io/v1, kind: Cluster, status: {lastPromotionToken: abc}}}}`)
	out, err := Compose(Input{XR: x, Observed: observed, Required: map[string][]Object{
		RequiredProject: project(t, "spec: {locations: {protected: "+rtm+", recovery: "+ams+"}}"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	// sha256("abc")[:16]
	if got := dig(clusterSpec(t, out, "recovery-cluster"), "postgresql", "parameters", "basis.last_promotion"); got != "ba7816bf8f01cfea" {
		t.Errorf("recovery site marker %v", got)
	}
	if got := dig(clusterSpec(t, out, "cluster"), "postgresql", "parameters", "basis.last_promotion"); got != nil {
		t.Errorf("protected site never promoted, marker %v", got)
	}
}

func TestAssets(t *testing.T) {
	rules, err := alertRules("payments", "orders-db", []string{"CNPGClusterHACritical"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 20 {
		t.Errorf("%d alert rules, want 21 minus the excluded one", len(rules))
	}
	text, _ := json.Marshal(rules)
	if strings.Contains(string(text), "zz") || !strings.Contains(string(text), `namespace=\"payments\"`) {
		t.Errorf("alert rules not scoped to the cluster")
	}
	var dash map[string]any
	if err := json.Unmarshal([]byte(dashboardJSON("payments", "orders-db", "cnpg-x")), &dash); err != nil {
		t.Fatalf("dashboard JSON: %v", err)
	}
	if dash["uid"] != "cnpg-x" || dash["title"] != "CloudNativePG / payments / orders-db" {
		t.Errorf("dashboard uid %v title %v", dash["uid"], dash["title"])
	}
}
