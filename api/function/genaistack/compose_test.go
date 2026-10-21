package genaistack

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func xr(t *testing.T, spec, status string) Object {
	t.Helper()
	var o Object
	if err := json.Unmarshal([]byte(`{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"GenAIStack",
		"metadata":{"name":"bot","namespace":"ai"},"spec":`+spec+`,"status":`+status+`}`), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

func required(recovery bool, caches ...string) map[string][]Object {
	locations := map[string]any{"protected": "dc-a"}
	if recovery {
		locations["recovery"] = "dc-b"
	}
	r := map[string][]Object{RequiredProject: {{"spec": map[string]any{"locations": locations}}},
		RequiredCacheSecret: {}, RequiredDRCacheSecret: {},
		RequiredGatewayKeys: {{"data": map[string]any{"apps": base64.StdEncoding.EncodeToString([]byte("gwkey"))}}}}
	pw := map[string]any{"password": base64.StdEncoding.EncodeToString([]byte("cachepw"))}
	for _, c := range caches {
		r[c] = []Object{{"data": pw}}
	}
	return r
}

func secretData(t *testing.T, c Composed) map[string]string {
	t.Helper()
	out := map[string]string{}
	for k, v := range c.Object["data"].(map[string]string) {
		raw, err := base64.StdEncoding.DecodeString(v)
		if err != nil {
			t.Fatal(err)
		}
		out[k] = string(raw)
	}
	return out
}

const models = `"gateway":{"models":[
	{"name":"gpt-4o-mini","endpoint":"https://api.openai.com/v1","apiKeySecretRef":{"name":"openai","key":"token"}},
	{"name":"llama","endpoint":"http://vllm.models.svc:8000/v1","upstreamModel":"meta-llama/Llama-3.1-8B-Instruct"}]}`

func TestCompose(t *testing.T) {
	NewSecret = func() string { return "generated" }

	t.Run("single site: database, cache, gateway and wiring in the protected location", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{`+models+`}`, `{}`), Required: required(false, RequiredCacheSecret)})
		if err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"database", "db-credentials", "cache", "gateway", "connection-protected", "protected-connection"} {
			if _, ok := out.Composed[key]; !ok {
				t.Errorf("missing %s", key)
			}
		}
		for _, key := range []string{"cache-dr", "connection-recovery", "recovery-connection"} {
			if _, ok := out.Composed[key]; ok {
				t.Errorf("%s composed without recovery", key)
			}
		}
		db := out.Composed["database"].Object["spec"].(Object)
		if db["profile"] != "vector" || db["postgresVersion"] != 18 || dig(db, "geoReplication", "enabled") != false {
			t.Errorf("database spec %v", db)
		}
		conn := secretData(t, out.Composed["connection-protected"])
		if conn["DATABASE_URL"] != "postgresql://bot_stack:generated@bot-db-rw.ai.svc:5432/app" ||
			conn["VALKEY_URL"] != "valkey://default:cachepw@valkey-bot-cache.ai.svc:6379" ||
			conn["OPENAI_BASE_URL"] != "http://bot-gateway.ai.svc/v1" || conn["OPENAI_API_KEY"] != "gwkey" ||
			conn["ACTIVE"] != "true" || conn["VALKEY_CLUSTER"] != "false" {
			t.Errorf("connection %v", conn)
		}
		if pc := dig(out.Composed["protected-connection"].Object, "spec", "providerConfigRef", "name"); pc != "dc-a" {
			t.Errorf("providerConfigRef %v", pc)
		}
		gw := out.Composed["gateway"].Object
		if gw["kind"] != "ModelGateway" || dig(gw, "metadata", "name") != "bot-gateway" || len(dig(gw, "spec", "models").([]any)) != 2 ||
			dig(gw, "metadata", "labels").(map[string]string)[OwnerLabel] != "bot" {
			t.Errorf("gateway %v", gw)
		}
		if out.Status.ActiveSite != "protected" || out.Status.Models != 2 || len(out.Status.Sites) != 1 {
			t.Errorf("status %+v", out.Status)
		}
	})

	t.Run("a shared gateway: the stack's client key, no gateway of its own", func(t *testing.T) {
		req := required(false, RequiredCacheSecret)
		req[RequiredGateway] = []Object{{"spec": map[string]any{}, "status": map[string]any{"models": float64(4),
			"conditions": []any{map[string]any{"type": "Ready", "status": "True"}}}}}
		req[RequiredGatewayKeys] = []Object{{"data": map[string]any{"bot": base64.StdEncoding.EncodeToString([]byte("botkey"))}}}
		out, err := Compose(Input{XR: xr(t, `{"gateway":{"ref":"shared"}}`, `{}`), Required: req})
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := out.Composed["gateway"]; ok {
			t.Error("composed a gateway next to the shared one")
		}
		conn := secretData(t, out.Composed["connection-protected"])
		if conn["OPENAI_BASE_URL"] != "http://shared.ai.svc/v1" || conn["OPENAI_API_KEY"] != "botkey" || out.Status.Models != 4 {
			t.Errorf("connection %v status %+v", conn, out.Status)
		}

		// Without a key for the stack's client it says what to do.
		req[RequiredGatewayKeys] = []Object{{"data": map[string]any{}}}
		out, _ = Compose(Input{XR: xr(t, `{"gateway":{"ref":"shared"}}`, `{}`), Required: req})
		if out.Status.Ready || !strings.Contains(out.Status.Message, "ModelGateway shared has no client bot") {
			t.Errorf("status %+v", out.Status)
		}
	})

	t.Run("the stack's switchover goes to the database", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"recovery":{"enabled":true,"activeSite":"recovery","promotion":"Failover"}}`, `{}`),
			Required: required(true, RequiredCacheSecret, RequiredDRCacheSecret)})
		if err != nil {
			t.Fatal(err)
		}
		geo := dig(out.Composed["database"].Object, "spec", "geoReplication").(Object)
		if geo["primarySite"] != "recovery" || geo["promotion"] != "Failover" {
			t.Errorf("geoReplication %v", geo)
		}
		// Until the database has moved, protected stays active.
		if out.Status.ActiveSite != "protected" || dig(out.Composed["gateway"].Object, "spec", "activeSite") != "protected" {
			t.Errorf("active site %s", out.Status.ActiveSite)
		}
	})

	t.Run("recovery: warm standby, the stack follows the database's primary", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"recovery":{"enabled":true},`+models+`}`, `{}`),
			Required: required(true, RequiredCacheSecret, RequiredDRCacheSecret)})
		if err != nil {
			t.Fatal(err)
		}
		db := out.Composed["database"].Object["spec"].(Object)
		if dig(db, "geoReplication", "enabled") != true || dig(db, "backup", "enabled") != true {
			t.Errorf("database spec %v", db)
		}
		if m := dig(out.Composed["cache"].Object, "spec", "resources", "memory"); m != "1Gi" {
			t.Errorf("active cache memory %v", m)
		}
		if m := dig(out.Composed["cache-dr"].Object, "spec", "resources", "memory"); m != "512Mi" {
			t.Errorf("standby cache memory %v", m)
		}
		if r := dig(out.Composed["gateway"].Object, "spec", "recovery"); r.(Object)["enabled"] != true || r.(Object)["replicas"] != 1 {
			t.Errorf("standby gateway %v", r)
		}
		if conn := secretData(t, out.Composed["connection-recovery"]); conn["ACTIVE"] != "false" ||
			!strings.Contains(conn["VALKEY_URL"], "valkey-bot-cache-dr.ai.svc") {
			t.Errorf("recovery connection %v", conn)
		}

		// After a switchover of the database the recovery site is active.
		observed := map[string]Object{"database": {"status": map[string]any{"primarySite": "recovery"}}}
		out, err = Compose(Input{XR: xr(t, `{"recovery":{"enabled":true},`+models+`}`, `{}`), Observed: observed,
			Required: required(true, RequiredCacheSecret, RequiredDRCacheSecret)})
		if err != nil {
			t.Fatal(err)
		}
		if out.Status.ActiveSite != "recovery" {
			t.Errorf("active site %s", out.Status.ActiveSite)
		}
		if m := dig(out.Composed["cache-dr"].Object, "spec", "resources", "memory"); m != "1Gi" {
			t.Errorf("now-active recovery cache memory %v", m)
		}
		if a := dig(out.Composed["gateway"].Object, "spec", "activeSite"); a != "recovery" {
			t.Errorf("gateway active site %v", a)
		}
	})

	t.Run("a recovery stack in a Project without a recovery location says so", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"recovery":{"enabled":true}}`, `{}`), Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		if out.Status.Ready || !strings.Contains(out.Status.Message, "no recovery location") {
			t.Errorf("status %+v", out.Status)
		}
	})

	t.Run("keeps generated credentials", func(t *testing.T) {
		observed := map[string]Object{"db-credentials": {"data": map[string]any{
			"password": base64.StdEncoding.EncodeToString([]byte("kept"))}}}
		out, err := Compose(Input{XR: xr(t, `{}`, `{}`), Observed: observed, Required: required(false, RequiredCacheSecret)})
		if err != nil {
			t.Fatal(err)
		}
		if conn := secretData(t, out.Composed["connection-protected"]); conn["DATABASE_PASSWORD"] != "kept" {
			t.Errorf("connection %v", conn)
		}
	})

	t.Run("without cache and gateway only the database and wiring", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"cache":{"enabled":false},"gateway":{"enabled":false}}`, `{}`), Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		for key := range out.Composed {
			if strings.Contains(key, "cache") || strings.Contains(key, "gateway") {
				t.Errorf("%s composed", key)
			}
		}
		if conn := secretData(t, out.Composed["connection-protected"]); conn["OPENAI_BASE_URL"] != "" || conn["VALKEY_URL"] != "" {
			t.Errorf("connection %v", conn)
		}
	})
}
