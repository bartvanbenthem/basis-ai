package mcpserver

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func xr(t *testing.T, spec, status string) Object {
	t.Helper()
	var o Object
	if err := json.Unmarshal([]byte(`{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"MCPServer",
		"metadata":{"name":"kb","namespace":"ai"},"spec":`+spec+`,"status":`+status+`}`), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

func project(recovery bool) Object {
	locations := map[string]any{"protected": "dc-a"}
	if recovery {
		locations["recovery"] = "dc-b"
	}
	return Object{"spec": map[string]any{"locations": locations}}
}

// stack is a GenAIStack as the composition sees it.
func stack(recovery bool, activeSite string) Object {
	return Object{"spec": map[string]any{"recovery": map[string]any{"enabled": recovery}},
		"status": map[string]any{"activeSite": activeSite}}
}

func manifest(c Composed) Object {
	m, _ := dig(c.Object, "spec", "forProvider", "manifest").(Object)
	return m
}

func container(t *testing.T, out *Output, site string) Object {
	t.Helper()
	d := manifest(out.Composed[site+"-deployment"])
	cs, _ := dig(d, "spec", "template", "spec", "containers").([]any)
	if len(cs) != 1 {
		t.Fatalf("%s: deployment %v", site, d)
	}
	return cs[0].(Object)
}

func config(t *testing.T, out *Output, site string) map[string]any {
	t.Helper()
	var c map[string]any
	if err := json.Unmarshal([]byte(dig(manifest(out.Composed[site+"-config"]), "data", "config.json").(string)), &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// observedDeployment is an Object whose Deployment the location reports with ready replicas.
func observedDeployment(ready int) Object {
	return Object{"status": map[string]any{"atProvider": map[string]any{"manifest": map[string]any{
		"kind": "Deployment", "status": map[string]any{"readyReplicas": float64(ready)}}}}}
}

func init() { NewKey = func() string { return "generated" } }

func TestComposeStack(t *testing.T) {
	out, err := Compose(Input{XR: xr(t, `{"database":{"stack":"support"}}`, `{}`),
		Required: map[string][]Object{RequiredProject: {project(true)}, RequiredDatabase: {stack(false, "protected")}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := out.Composed["recovery-deployment"]; ok {
		t.Error("recovery site without recovery.enabled")
	}
	for _, k := range []string{"keys", "dashboard", "protected-keys", "protected-config", "protected-deployment", "protected-service",
		"protected-pdb", "protected-podmonitor", "protected-prometheusrule"} {
		if _, ok := out.Composed[k]; !ok {
			t.Errorf("no %s", k)
		}
	}
	for _, k := range []string{"protected-database", "protected-embeddings"} {
		if _, ok := out.Composed[k]; ok {
			t.Errorf("%s with a stack: it brings its own", k)
		}
	}
	if dig(out.Composed["protected-deployment"].Object, "spec", "providerConfigRef", "name") != "dc-a" {
		t.Errorf("deployment's location %v", out.Composed["protected-deployment"].Object)
	}
	main := container(t, out, "protected")
	if main["image"] != DefaultImage || dig(main, "envFrom") == nil ||
		dig(main["envFrom"].([]any)[0], "secretRef", "name") != "support-connection" || main["env"] != nil {
		t.Errorf("container %v: the stack's connection Secret", main)
	}
	if dig(manifest(out.Composed["protected-deployment"]), "spec", "replicas") != 2 {
		t.Errorf("replicas: 2 by default")
	}
	// The XRD's defaults: text search without a model, the server's own tables, client agents.
	cfg := config(t, out, "protected")
	if dig(cfg, "retrieval", "mode") != "text" || dig(cfg, "retrieval", "table") != "mcp.documents" || dig(cfg, "retrieval", "own") != true ||
		dig(cfg, "memory", "scope") != "client" || dig(cfg, "site") != "protected" || dig(cfg, "clients", "agents") == nil ||
		len(dig(cfg, "embeddings").(map[string]any)) != 0 {
		t.Errorf("config %v", cfg)
	}
	keys := out.Composed["keys"].Object["data"].(map[string]string)
	if raw, _ := base64.StdEncoding.DecodeString(keys["agents"]); string(raw) != "generated" || len(keys) != 1 {
		t.Errorf("keys %v", keys)
	}
	if refs := dig(out.Composed["protected-keys"].Object, "spec", "references").([]any); len(refs) != 2 ||
		dig(refs[0], "patchesFrom", "name") != "kb-keys" {
		t.Errorf("keys copied from the control plane: %v", refs)
	}
	if has := manifest(out.Composed["protected-keys"])["data"]; has != nil {
		t.Errorf("key data in the Object spec: %v", has)
	}
	s := out.Status
	if s.Endpoint != "http://kb.ai.svc/mcp" || s.Database != "GenAIStack/support" || s.ActiveSite != "protected" || s.Clients != 1 ||
		strings.Join(s.Tools, ",") != "search,fetch,remember,recall,forget" || s.ToolCount != 5 || s.Ready || s.KeysSecret != "kb-keys" {
		t.Errorf("status %+v", s)
	}
	if out.Condition.Reason != "Creating" || !strings.Contains(s.Message, "Waiting for the server's pods") {
		t.Errorf("condition %+v", out.Condition)
	}

	// Ready once the location reports ready pods and the keys exist.
	observed := map[string]Object{"keys": {"data": map[string]any{"agents": base64.StdEncoding.EncodeToString([]byte("kept"))}}}
	for k, c := range out.Composed {
		if strings.HasPrefix(k, "protected-") {
			observed[k] = Object{"status": map[string]any{"conditions": []any{map[string]any{"type": "Ready", "status": "True"}},
				"atProvider": map[string]any{"manifest": dig(c.Object, "spec", "forProvider", "manifest")}}}
		}
	}
	observed["protected-deployment"] = observedDeployment(1)
	out, _ = Compose(Input{XR: xr(t, `{"database":{"stack":"support"}}`, `{}`), Observed: observed,
		Required: map[string][]Object{RequiredProject: {project(true)}, RequiredDatabase: {stack(false, "protected")}}})
	if !out.Status.Ready || out.Condition.Reason != "Available" || !strings.Contains(out.Status.Message, "ready with 5 tool(s) over GenAIStack/support") {
		t.Errorf("observed ready: %+v %+v", out.Status, out.Condition)
	}
	if raw, _ := base64.StdEncoding.DecodeString(out.Composed["keys"].Object["data"].(map[string]string)["agents"]); string(raw) != "kept" {
		t.Errorf("an existing key must be kept, got %q", raw)
	}
}

func TestComposeCluster(t *testing.T) {
	spec := `{"database":{"cluster":"docs","name":"kb","credentialsSecretRef":{"name":"kb-role"}},
		"embeddings":{"model":"bge-m3","gateway":"shared","dimensions":512},
		"retrieval":{"table":"public.chunks","columns":{"content":"body","embedding":"vec"},"topK":4,"textSearchConfig":"english"},
		"memory":{"scope":"shared","retentionDays":90},
		"clients":[{"name":"claude"},{"name":"reader","tools":["search","fetch"]}],
		"replicas":1,"image":"registry.local/basis-mcp:v1"}`
	gwKeys := Object{"data": map[string]any{"kb": base64.StdEncoding.EncodeToString([]byte("gw-key"))}}
	req := func(keys Object) map[string][]Object {
		r := map[string][]Object{RequiredProject: {project(false)}, RequiredDatabase: {{"status": map[string]any{"primarySite": "protected"}}}}
		if keys != nil {
			r[RequiredGatewayKeys] = []Object{keys}
		}
		return r
	}
	reqs := Requirements(xr(t, spec, `{}`))
	if reqs[RequiredDatabase].Kind != "PostgresCluster" || reqs[RequiredDatabase].Name != "docs" || reqs[RequiredGatewayKeys].Name != "shared-keys" {
		t.Errorf("requirements %+v", reqs)
	}

	out, err := Compose(Input{XR: xr(t, spec, `{}`), Required: req(gwKeys)})
	if err != nil {
		t.Fatal(err)
	}
	main := container(t, out, "protected")
	env := map[string]any{}
	for _, e := range main["env"].([]any) {
		e := e.(Object)
		if v, ok := e["value"]; ok {
			env[e["name"].(string)] = v
		} else {
			env[e["name"].(string)] = dig(e, "valueFrom", "secretKeyRef", "name").(string) + "/" + dig(e, "valueFrom", "secretKeyRef", "key").(string)
		}
	}
	want := map[string]any{
		"DATABASE_URL": "postgresql://docs-rw.ai.svc:5432/kb", "PGUSER": "kb-database/username", "PGPASSWORD": "kb-database/password",
		"OPENAI_BASE_URL": "http://shared.ai.svc/v1", "OPENAI_API_KEY": "kb-embeddings/apiKey",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env %s = %v, want %v", k, env[k], v)
		}
	}
	if main["image"] != "registry.local/basis-mcp:v1" {
		t.Errorf("image %v", main["image"])
	}
	ref := dig(out.Composed["protected-embeddings"].Object, "spec", "references").([]any)[0]
	if dig(ref, "patchesFrom", "name") != "shared-keys" || dig(ref, "patchesFrom", "fieldPath") != "data.kb" || dig(ref, "toFieldPath") != "data.apiKey" {
		t.Errorf("the server's key at the gateway: %v", ref)
	}
	if dig(out.Composed["protected-database"].Object, "spec", "references").([]any)[0].(map[string]any)["patchesFrom"].(map[string]any)["name"] != "kb-role" {
		t.Errorf("the role's credentials copied: %v", out.Composed["protected-database"].Object)
	}
	if _, ok := out.Composed["protected-pdb"]; ok {
		t.Error("a PodDisruptionBudget for one replica blocks node drains")
	}

	cfg := config(t, out, "protected")
	if dig(cfg, "retrieval", "mode") != "hybrid" || dig(cfg, "retrieval", "own") != false || dig(cfg, "retrieval", "columns", "content") != "body" ||
		dig(cfg, "retrieval", "columns", "id") != "id" || dig(cfg, "retrieval", "topK") != float64(4) ||
		dig(cfg, "embeddings", "model") != "bge-m3" || dig(cfg, "embeddings", "dimensions") != float64(512) ||
		dig(cfg, "memory", "scope") != "shared" || dig(cfg, "memory", "retentionDays") != float64(90) {
		t.Errorf("config %v", cfg)
	}
	if tools := dig(cfg, "clients", "reader", "tools").([]any); len(tools) != 2 || len(dig(cfg, "clients", "claude", "tools").([]any)) != 0 {
		t.Errorf("clients' tools %v", dig(cfg, "clients"))
	}
	rules := dig(manifest(out.Composed["protected-prometheusrule"]), "spec", "groups").([]any)[0].(Object)["rules"].([]any)
	if len(rules) != 5 || rules[4].(Object)["alert"] != "BasisMCPServerEmbeddingsFailing" {
		t.Errorf("rules %v: with embeddings, five", rules)
	}
	if out.Status.Database != "PostgresCluster/docs" || out.Condition.Reason != "Creating" {
		t.Errorf("status %+v", out.Status)
	}

	// The gateway hasn't got the server's client.
	out, _ = Compose(Input{XR: xr(t, spec, `{}`), Required: req(Object{"data": map[string]any{}})})
	if out.Condition.Reason != "Waiting" || !strings.Contains(out.Status.Message, "ModelGateway shared has no client kb for the embeddings") {
		t.Errorf("missing client: %+v", out.Condition)
	}
}

func TestComposeRecovery(t *testing.T) {
	spec := `{"database":{"stack":"support"},"embeddings":{"model":"m"},"replicas":3,"recovery":{"enabled":true,"replicas":1}}`
	out, _ := Compose(Input{XR: xr(t, spec, `{}`),
		Required: map[string][]Object{RequiredProject: {project(true)}, RequiredDatabase: {stack(true, "recovery")}}})
	if out.Status.ActiveSite != "recovery" {
		t.Fatalf("active site %q: follows the stack's", out.Status.ActiveSite)
	}
	if dig(manifest(out.Composed["recovery-deployment"]), "spec", "replicas") != 3 ||
		dig(manifest(out.Composed["protected-deployment"]), "spec", "replicas") != 1 {
		t.Errorf("the active site gets spec.replicas, the standby recovery.replicas")
	}
	if dig(out.Composed["recovery-deployment"].Object, "spec", "providerConfigRef", "name") != "dc-b" || config(t, out, "recovery")["site"] != "recovery" {
		t.Errorf("recovery site's location and config")
	}
	if len(out.Status.Sites) != 2 || !out.Status.Sites[1].Active || out.Status.Sites[0].Active {
		t.Errorf("sites %+v", out.Status.Sites)
	}

	// Pinned sites stay; a stack without a recovery site is a problem.
	out, _ = Compose(Input{XR: xr(t, spec, `{"sites":[{"site":"protected","location":"dc-old"}]}`),
		Required: map[string][]Object{RequiredProject: {project(true)}, RequiredDatabase: {stack(false, "protected")}}})
	if dig(out.Composed["protected-deployment"].Object, "spec", "providerConfigRef", "name") != "dc-old" {
		t.Errorf("a pinned site moved")
	}
	if !strings.Contains(out.Status.Message, "GenAIStack support has no recovery site") || out.Status.Ready {
		t.Errorf("message %q", out.Status.Message)
	}

	// A standby with no replicas has no alerts.
	out, _ = Compose(Input{XR: xr(t, `{"database":{"stack":"support"},"recovery":{"enabled":true,"replicas":0}}`, `{}`),
		Required: map[string][]Object{RequiredProject: {project(true)}, RequiredDatabase: {stack(true, "protected")}}})
	if _, ok := out.Composed["recovery-prometheusrule"]; ok {
		t.Error("alerts for a standby without replicas")
	}
	if _, ok := out.Composed["protected-prometheusrule"]; !ok {
		t.Error("no alerts for the active site")
	}
}

func TestComposeClients(t *testing.T) {
	Now = func() time.Time { return time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC) }
	defer func() { Now = time.Now }()
	spec := `{"database":{"stack":"support"},"retrieval":{"ingest":true},"memory":{"enabled":false},
		"clients":[{"name":"old","expiresAt":"2026-10-22"},{"name":"today","expiresAt":"2026-10-23"},{"name":"ci","tools":["search"]}]}`
	out, _ := Compose(Input{XR: xr(t, spec, `{}`),
		Required: map[string][]Object{RequiredProject: {project(false)}, RequiredDatabase: {stack(false, "")}}})
	keys := out.Composed["keys"].Object["data"].(map[string]string)
	if _, ok := keys["old"]; ok || keys["today"] == "" || keys["ci"] == "" {
		t.Errorf("keys %v: an expired client's goes, the last day still counts", keys)
	}
	if _, ok := dig(config(t, out, "protected"), "clients").(map[string]any)["old"]; ok {
		t.Error("an expired client in the config")
	}
	if strings.Join(out.Status.ExpiredClients, ",") != "old" || out.Status.Clients != 2 {
		t.Errorf("status %+v", out.Status)
	}
	if strings.Join(out.Status.Tools, ",") != "search,fetch,add_document,delete_document" {
		t.Errorf("tools %v", out.Status.Tools)
	}

	// A config change rolls the pods (the hash); the keys don't.
	hash := func(o *Output) any {
		return dig(manifest(o.Composed["protected-deployment"]), "spec", "template", "metadata", "annotations").(map[string]string)["ai.cndev.nl/config-hash"]
	}
	other, _ := Compose(Input{XR: xr(t, strings.Replace(spec, `"tools":["search"]`, `"tools":["search","fetch"]`, 1), `{}`),
		Required: map[string][]Object{RequiredProject: {project(false)}, RequiredDatabase: {stack(false, "")}}})
	if hash(out) == hash(other) {
		t.Error("the config hash didn't change with the config")
	}
}

func TestComposeProblems(t *testing.T) {
	out, _ := Compose(Input{XR: xr(t, `{"database":{"stack":"nope"},"alerts":{"disabled":true}}`, `{}`),
		Required: map[string][]Object{RequiredProject: {{}}}})
	if !strings.Contains(out.Status.Message, "no GenAIStack nope in namespace ai") ||
		!strings.Contains(out.Status.Message, "Project ai has no protected location") || out.Condition.Reason != "Waiting" {
		t.Errorf("message %q", out.Status.Message)
	}
	out, _ = Compose(Input{XR: xr(t, `{"database":{"stack":"s"},"embeddings":{"model":"m"}}`, `{}`),
		Required: map[string][]Object{RequiredProject: {project(false)},
			RequiredDatabase: {{"spec": map[string]any{"gateway": map[string]any{"enabled": false}}}}}})
	if !strings.Contains(out.Status.Message, "GenAIStack s has no gateway for the embeddings") {
		t.Errorf("message %q", out.Status.Message)
	}
	out, _ = Compose(Input{XR: xr(t, `{"database":{"cluster":"c","credentialsSecretRef":{"name":"r"}},"recovery":{"enabled":true}}`, `{}`),
		Required: map[string][]Object{RequiredProject: {project(true)}, RequiredDatabase: {{"spec": map[string]any{}}}}})
	if !strings.Contains(out.Status.Message, "PostgresCluster c isn't geo-replicated") {
		t.Errorf("message %q", out.Status.Message)
	}
	if _, ok := out.Composed["protected-prometheusrule"]; !ok {
		t.Error("alerts on by default")
	}
}
