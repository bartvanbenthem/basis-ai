package modelgateway

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func xr(t *testing.T, spec, status string) Object {
	t.Helper()
	var o Object
	if err := json.Unmarshal([]byte(`{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"ModelGateway",
		"metadata":{"name":"llm","namespace":"ai"},"spec":`+spec+`,"status":`+status+`}`), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

func required(recovery bool) map[string][]Object {
	locations := map[string]any{"protected": "dc-a"}
	if recovery {
		locations["recovery"] = "dc-b"
	}
	return map[string][]Object{RequiredProject: {{"spec": map[string]any{"locations": locations}}}}
}

func manifest(c Composed) Object {
	m, _ := dig(c.Object, "spec", "forProvider", "manifest").(Object)
	return m
}

const models = `"models":[
	{"name":"gpt-4o-mini","endpoint":"https://api.openai.com/v1","apiKeySecretRef":{"name":"openai","key":"token"}},
	{"name":"claude","endpoint":"https://api.anthropic.com/v1","schema":"Anthropic","apiKeySecretRef":{"name":"anthropic"}},
	{"name":"llama","endpoint":"http://vllm.models.svc:8000/v1","upstreamModel":"meta-llama/Llama-3.1-8B-Instruct"}]`

func TestCompose(t *testing.T) {
	NewKey = func() string { return "generated" }

	t.Run("one site: Agent Router in the protected location", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{`+models+`}`, `{}`), Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"keys", "protected-gateway", "protected-envoyproxy", "protected-keys",
			"protected-securitypolicy", "protected-clienttraffic", "protected-route"} {
			if _, ok := out.Composed[key]; !ok {
				t.Errorf("missing %s", key)
			}
		}
		if pc := dig(out.Composed["protected-gateway"].Object, "spec", "providerConfigRef", "name"); pc != "dc-a" {
			t.Errorf("providerConfigRef %v", pc)
		}
		ep := manifest(out.Composed["protected-envoyproxy"])
		if s := dig(ep, "spec", "provider", "kubernetes", "envoyService"); s.(Object)["name"] != "llm" {
			t.Errorf("service %v", s)
		}
		if out.Status.Endpoint != "http://llm.ai.svc/v1" || out.Status.KeysSecret != "llm-keys" || out.Status.Models != 3 {
			t.Errorf("status %+v", out.Status)
		}
	})

	t.Run("a key per client, kept once generated", func(t *testing.T) {
		observed := map[string]Object{"keys": {"data": map[string]any{"agent": base64.StdEncoding.EncodeToString([]byte("kept"))}}}
		out, err := Compose(Input{XR: xr(t, `{"clients":[{"name":"agent"},{"name":"chat"}]}`, `{}`), Observed: observed, Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		data := out.Composed["keys"].Object["data"].(map[string]string)
		dec := func(k string) string { raw, _ := base64.StdEncoding.DecodeString(data[k]); return string(raw) }
		if dec("agent") != "kept" || dec("chat") != "generated" || len(data) != 2 || out.Status.Clients != 2 {
			t.Errorf("keys %v", data)
		}
	})

	t.Run("models: route, backends, TLS for https, provider keys", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{`+models+`}`, `{}`), Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		route, _ := json.Marshal(manifest(out.Composed["protected-route"]))
		if !strings.Contains(string(route), `"value":"gpt-4o-mini"`) || !strings.Contains(string(route), `"modelNameOverride":"meta-llama/Llama-3.1-8B-Instruct"`) {
			t.Errorf("route %s", route)
		}
		openai := "model-" + sha1hex("gpt-4o-mini")[:8]
		claude := "model-" + sha1hex("claude")[:8]
		llama := "model-" + sha1hex("llama")[:8]
		if _, ok := out.Composed["protected-"+openai+"-tls"]; !ok {
			t.Error("no BackendTLSPolicy for the https endpoint")
		}
		if _, ok := out.Composed["protected-"+llama+"-tls"]; ok {
			t.Error("BackendTLSPolicy for a plain http endpoint")
		}
		backend, _ := json.Marshal(manifest(out.Composed["protected-"+llama+"-backend"]))
		if !strings.Contains(string(backend), `"hostname":"vllm.models.svc","port":8000`) {
			t.Errorf("backend %s", backend)
		}
		if prefix := dig(manifest(out.Composed["protected-"+openai+"-aiservicebackend"]), "spec", "schema", "prefix"); prefix != "/v1" {
			t.Errorf("prefix %v", prefix)
		}
		refs, _ := json.Marshal(dig(out.Composed["protected-"+openai+"-apikey"].Object, "spec", "references"))
		if !strings.Contains(string(refs), `"fieldPath":"data.token"`) || !strings.Contains(string(refs), `"toFieldPath":"data.apiKey"`) {
			t.Errorf("api key references %s", refs)
		}
		if typ := dig(manifest(out.Composed["protected-"+claude+"-backendsecurity"]), "spec", "type"); typ != "AnthropicAPIKey" {
			t.Errorf("Anthropic key type %v", typ)
		}
		if _, ok := out.Composed["protected-"+llama+"-apikey"]; ok {
			t.Error("api key copied for a model without one")
		}
	})

	t.Run("recovery: a standby, the active site gets the replicas", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"recovery":{"enabled":true},"activeSite":"recovery"}`, `{}`), Required: required(true)})
		if err != nil {
			t.Fatal(err)
		}
		replicas := func(site string) any {
			return dig(manifest(out.Composed[site+"-envoyproxy"]), "spec", "provider", "kubernetes", "envoyDeployment", "replicas")
		}
		if replicas("recovery") != 2 || replicas("protected") != 1 || out.Status.ActiveSite != "recovery" {
			t.Errorf("replicas protected %v recovery %v, status %+v", replicas("protected"), replicas("recovery"), out.Status)
		}
		if pc := dig(out.Composed["recovery-gateway"].Object, "spec", "providerConfigRef", "name"); pc != "dc-b" {
			t.Errorf("providerConfigRef %v", pc)
		}
	})

	t.Run("a stack's gateway carries the stack's label", func(t *testing.T) {
		x := xr(t, `{}`, `{}`)
		x["metadata"].(Object)["labels"] = map[string]any{"ai.cndev.nl/genaistack": "bot"}
		out, err := Compose(Input{XR: x, Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		if l := dig(out.Composed["protected-gateway"].Object, "metadata", "labels"); l.(map[string]string)["ai.cndev.nl/genaistack"] != "bot" {
			t.Errorf("labels %v", l)
		}
	})

	t.Run("recovery in a Project without a recovery location says so", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"recovery":{"enabled":true}}`, `{}`), Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		if out.Status.Ready || !strings.Contains(out.Status.Message, "no recovery location") {
			t.Errorf("status %+v", out.Status)
		}
	})
}
