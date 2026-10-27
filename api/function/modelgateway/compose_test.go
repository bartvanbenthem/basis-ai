package modelgateway

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
			"protected-securitypolicy", "protected-clienttraffic", "protected-backendtraffic", "protected-route"} {
			if _, ok := out.Composed[key]; !ok {
				t.Errorf("missing %s", key)
			}
		}
		if pc := dig(out.Composed["protected-gateway"].Object, "spec", "providerConfigRef", "name"); pc != "dc-a" {
			t.Errorf("providerConfigRef %v", pc)
		}
		// Images in requests and embeddings in responses: well over Envoy's defaults.
		if w := dig(manifest(out.Composed["protected-clienttraffic"]), "spec", "http2", "initialStreamWindowSize"); w != "50Mi" {
			t.Errorf("HTTP/2 stream window %v", w)
		}
		if b := dig(manifest(out.Composed["protected-backendtraffic"]), "spec", "connection", "bufferLimit"); b != "50Mi" {
			t.Errorf("backend buffer %v", b)
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

	t.Run("expose: an HTTPS Gateway of its own on a LoadBalancer, the internal one stays", func(t *testing.T) {
		spec := `{"expose":{"enabled":true,"hostname":"llm.example.com","loadBalancerSourceRanges":["203.0.113.0/24"],
			"annotations":{"lb.example/internal":"false"}},` + models + `}`
		out, err := Compose(Input{XR: xr(t, spec, `{}`), Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		if s := dig(manifest(out.Composed["protected-envoyproxy"]), "spec", "provider", "kubernetes", "envoyService", "type"); s != "ClusterIP" {
			t.Errorf("internal service type %v", s)
		}
		svc, _ := json.Marshal(dig(manifest(out.Composed["protected-external-envoyproxy"]), "spec", "provider", "kubernetes", "envoyService"))
		if !strings.Contains(string(svc), `"name":"llm-external"`) || !strings.Contains(string(svc), `"type":"LoadBalancer"`) ||
			!strings.Contains(string(svc), `"loadBalancerSourceRanges":["203.0.113.0/24"]`) || !strings.Contains(string(svc), `"lb.example/internal":"false"`) {
			t.Errorf("external service %s", svc)
		}
		cert, _ := json.Marshal(dig(manifest(out.Composed["protected-certificate"]), "spec"))
		if !strings.Contains(string(cert), `"dnsNames":["llm.example.com"]`) || !strings.Contains(string(cert), `"kind":"ClusterIssuer","name":"basis"`) {
			t.Errorf("certificate %s", cert)
		}
		listeners, _ := json.Marshal(dig(manifest(out.Composed["protected-external-gateway"]), "spec", "listeners"))
		if !strings.Contains(string(listeners), `"protocol":"HTTPS"`) || strings.Contains(string(listeners), `"protocol":"HTTP"`) ||
			!strings.Contains(string(listeners), `"name":"llm-tls"`) {
			t.Errorf("external listeners %s", listeners)
		}
		for _, k := range []string{"route", "securitypolicy", "clienttraffic", "backendtraffic"} {
			refs, _ := json.Marshal(manifest(out.Composed["protected-"+k]))
			if !strings.Contains(string(refs), `"name":"llm-external"`) {
				t.Errorf("%s does not cover the external Gateway: %s", k, refs)
			}
		}
		if out.Status.ExternalEndpoint != "https://llm.example.com/v1" || out.Status.Endpoint != "http://llm.ai.svc/v1" {
			t.Errorf("status %+v", out.Status)
		}
	})

	t.Run("expose: waits for the certificate and the address, then reports it", func(t *testing.T) {
		spec := `{"expose":{"enabled":true,"hostname":"llm.example.com","issuer":"acme","loadBalancerSourceRanges":["0.0.0.0/0"]}}`
		live := func(m Object) Object {
			return Object{"status": Object{"atProvider": Object{"manifest": m}}}
		}
		cond := func(t string) Object { return Object{"conditions": []any{Object{"type": t, "status": "True"}}} }
		observed := map[string]Object{"keys": {}}
		for _, k := range []string{"envoyproxy", "clienttraffic", "backendtraffic", "securitypolicy", "external-envoyproxy"} {
			observed["protected-"+k] = live(Object{"kind": "x"})
		}
		observed["protected-keys"] = Object{"status": cond("Ready")}
		observed["protected-gateway"] = live(Object{"status": cond("Programmed")})
		out, err := Compose(Input{XR: xr(t, spec, `{}`), Observed: observed, Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		if out.Status.Ready || !strings.Contains(out.Status.Message, "ClusterIssuer acme") || !strings.Contains(out.Status.Message, "LoadBalancer address in dc-a") {
			t.Errorf("status %+v", out.Status)
		}
		observed["protected-certificate"] = live(Object{"status": cond("Ready")})
		gw := cond("Programmed")
		gw["addresses"] = []any{Object{"type": "IPAddress", "value": "198.51.100.7"}}
		observed["protected-external-gateway"] = live(Object{"status": gw})
		out, err = Compose(Input{XR: xr(t, spec, `{}`), Observed: observed, Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		if !out.Status.Ready || out.Status.Sites[0].Address != "198.51.100.7" {
			t.Errorf("status %+v", out.Status)
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

func TestGovernance(t *testing.T) {
	NewKey = func() string { return "generated" }
	Now = func() time.Time { return time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC) }
	defer func() { Now = time.Now }()

	spec := `{` + models + `,"monthlyTokens":5000000,"clients":[
		{"name":"apps","monthlyTokens":1000000},
		{"name":"bot","owner":"team-ai","expiresAt":"2026-10-22"},
		{"name":"old","monthlyTokens":10,"expiresAt":"2026-10-21"}]}`
	out, err := Compose(Input{XR: xr(t, spec, `{}`), Required: required(false)})
	if err != nil {
		t.Fatal(err)
	}

	// A client past its last day loses its key; one on its last day keeps it.
	keys := out.Composed["keys"].Object["data"].(map[string]string)
	if _, ok := keys["old"]; ok || keys["bot"] == "" || len(out.Status.ExpiredClients) != 1 || out.Status.ExpiredClients[0] != "old" {
		t.Errorf("keys %v, expired %v", keys, out.Status.ExpiredClients)
	}

	// Who called goes upstream, each request's tokens into metadata.
	if h := dig(manifest(out.Composed["protected-securitypolicy"]), "spec", "apiKeyAuth", "forwardClientIDHeader"); h != ClientHeader {
		t.Errorf("client header %v", h)
	}
	costs, _ := json.Marshal(dig(manifest(out.Composed["protected-route"]), "spec", "llmRequestCosts"))
	if !strings.Contains(string(costs), `"metadataKey":"llm_total_token","type":"TotalToken"`) {
		t.Errorf("request costs %s", costs)
	}

	// Monthly caps: apps, and the gateway as a whole; not the expired client.
	limits, _ := json.Marshal(manifest(out.Composed["protected-ratelimit"]))
	for _, want := range []string{
		`"targetRefs":[{"group":"gateway.networking.k8s.io","kind":"HTTPRoute","name":"llm"}]`,
		`"mergeType":"StrategicMerge"`,
		`{"clientSelectors":[{"headers":[{"name":"x-basis-client","type":"Exact","value":"apps"}]}],"cost":`,
		`"limit":{"requests":1000000,"unit":"Month"}`,
		`"limit":{"requests":5000000,"unit":"Month"}`,
		`"response":{"from":"Metadata","metadata":{"key":"llm_total_token","namespace":"io.envoy.ai_gateway"}}`,
	} {
		if !strings.Contains(string(limits), want) {
			t.Errorf("limits lack %s\n%s", want, limits)
		}
	}
	if strings.Contains(string(limits), `"value":"old"`) {
		t.Error("a cap for an expired client")
	}

	// Token metrics for the Project's cost, and an access log on each Gateway.
	pm, _ := json.Marshal(manifest(out.Composed["protected-podmonitor"]))
	if !strings.Contains(string(pm), `"values":["llm"]`) || !strings.Contains(string(pm), `"targetPort":1064`) {
		t.Errorf("podmonitor %s", pm)
	}
	log, _ := json.Marshal(dig(manifest(out.Composed["protected-envoyproxy"]), "spec", "telemetry"))
	if !strings.Contains(string(log), `"client":"%REQ(X-BASIS-CLIENT)%"`) || !strings.Contains(string(log), `"total_tokens":"%DYNAMIC_METADATA(io.envoy.ai_gateway:llm_total_token)%"`) {
		t.Errorf("access log %s", log)
	}

	// No caps, no rate limit policy.
	out, _ = Compose(Input{XR: xr(t, `{`+models+`}`, `{}`), Required: required(false)})
	if _, ok := out.Composed["protected-ratelimit"]; ok {
		t.Error("rate limits without monthlyTokens")
	}
}

func TestResilience(t *testing.T) {
	NewKey = func() string { return "generated" }
	spec := `{"models":[
		{"name":"primary","endpoint":"https://api.openai.com/v1","upstreamModel":"gpt-4o","fallbacks":["backup","local","primary","nope"]},
		{"name":"backup","endpoint":"https://api.mistral.ai/v1","upstreamModel":"mistral-large"},
		{"name":"local","endpoint":"http://vllm.models.svc:8000/v1"}],
		"retry":{"attempts":2,"retryOn":[429,503],"perTryTimeout":"60s"},
		"rateLimit":{"requestsPerMinute":600},
		"clients":[{"name":"apps","tokensPerMinute":20000}],
		"alerts":{"latencySeconds":30}}`
	out, err := Compose(Input{XR: xr(t, spec, `{}`), Required: required(false)})
	if err != nil {
		t.Fatal(err)
	}

	// A model's fallbacks, a priority each, with their own upstream names;
	// itself and unknown names skipped.
	rules := dig(manifest(out.Composed["protected-route"]), "spec", "rules").([]any)
	var primary []any
	for _, r := range rules {
		if dig(r, "matches").([]any)[0].(Object)["headers"].([]any)[0].(Object)["value"] == "primary" {
			primary = r.(Object)["backendRefs"].([]any)
		}
	}
	refs, _ := json.Marshal(primary)
	if string(refs) != `[{"modelNameOverride":"gpt-4o","name":"llm-model-`+sha1hex("primary")[:8]+`"},`+
		`{"modelNameOverride":"mistral-large","name":"llm-model-`+sha1hex("backup")[:8]+`","priority":1},`+
		`{"modelNameOverride":"local","name":"llm-model-`+sha1hex("local")[:8]+`","priority":2}]` {
		t.Errorf("primary's backends %s", refs)
	}

	// 2 attempts on each of 3 priorities: 5 retries, moving on after 2.
	retry, _ := json.Marshal(dig(manifest(out.Composed["protected-backendtraffic"]), "spec", "retry"))
	for _, want := range []string{`"numRetries":5`, `"numAttemptsPerPriority":2`, `"httpStatusCodes":[429,503]`, `"timeout":"60s"`} {
		if !strings.Contains(string(retry), want) {
			t.Errorf("retry lacks %s: %s", want, retry)
		}
	}
	// The buffers stay where they were.
	if b := dig(manifest(out.Composed["protected-backendtraffic"]), "spec", "connection", "bufferLimit"); b != "50Mi" {
		t.Errorf("buffer %v", b)
	}

	// Per-minute caps: requests for the gateway, tokens for apps.
	limits, _ := json.Marshal(manifest(out.Composed["protected-ratelimit"]))
	for _, want := range []string{`{"limit":{"requests":600,"unit":"Minute"},"shared":true}`,
		`"limit":{"requests":20000,"unit":"Minute"}`, `"value":"apps"`} {
		if !strings.Contains(string(limits), want) {
			t.Errorf("limits lack %s: %s", want, limits)
		}
	}

	// Metrics labelled with gateway and model; alerts; the dashboard.
	pm, _ := json.Marshal(manifest(out.Composed["protected-podmonitor"]))
	for _, want := range []string{`"targetLabel":"gateway"`, `"port":"metrics","relabelings"`,
		`"regex":"httproute/ai/llm/rule/0","replacement":"backup","sourceLabels":["envoy_cluster_name"],"targetLabel":"model"`} {
		if !strings.Contains(string(pm), want) {
			t.Errorf("podmonitor lacks %s: %s", want, pm)
		}
	}
	slow := dig(manifest(out.Composed["protected-prometheusrule"]), "spec", "groups").([]any)[0].(Object)["rules"].([]any)[0].(Object)
	if !strings.HasSuffix(slow["expr"].(string), `rate(gen_ai_server_request_duration_seconds_bucket{namespace="ai",gateway="llm"}[10m]))) > 30`) {
		t.Errorf("latency alert %v", slow["expr"])
	}
	if d := out.Composed["dashboard"]; d.Object["kind"] != "GrafanaDashboard" || !d.Ready {
		t.Errorf("dashboard %v", d.Object["kind"])
	}

	// One attempt and no fallbacks: no retry; alerts off: no rule.
	out, _ = Compose(Input{XR: xr(t, `{`+models+`,"retry":{"attempts":1},"alerts":{"disabled":true}}`, `{}`), Required: required(false)})
	if r := dig(manifest(out.Composed["protected-backendtraffic"]), "spec", "retry"); r != nil {
		t.Errorf("retry %v", r)
	}
	if _, ok := out.Composed["protected-prometheusrule"]; ok {
		t.Error("alerts though disabled")
	}
}

func TestSelfHosted(t *testing.T) {
	NewKey = func() string { return "generated" }
	modelServer := func(name, spec string) Object {
		var o Object
		if err := json.Unmarshal([]byte(`{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"ModelServer",
			"metadata":{"name":"`+name+`","namespace":"ai"},"spec":`+spec+`}`), &o); err != nil {
			t.Fatal(err)
		}
		return o
	}
	rules := func(out *Output, site string) map[string][]any {
		got := map[string][]any{}
		for _, r := range dig(manifest(out.Composed[site+"-route"]), "spec", "rules").([]any) {
			got[dig(r.(Object)["matches"].([]any)[0], "headers").([]any)[0].(Object)["value"].(string)] = r.(Object)["backendRefs"].([]any)
		}
		return got
	}

	t.Run("asks for the ModelServers it names", func(t *testing.T) {
		reqs := Requirements(xr(t, `{"models":[{"name":"llama","server":"llama"},{"name":"gpt","endpoint":"https://api.openai.com/v1"}]}`, `{}`))
		if r := reqs["server-llama"]; r.Kind != "ModelServer" || r.Namespace != "ai" || r.Name != "llama" || len(reqs) != 2 {
			t.Errorf("requirements %+v", reqs)
		}
	})

	t.Run("the InferencePool, where the server runs", func(t *testing.T) {
		required := required(true)
		required["server-llama"] = []Object{modelServer("llama", `{"model":{"uri":"hf://x/y"}}`)}
		out, err := Compose(Input{XR: xr(t, `{"recovery":{"enabled":true},"models":[{"name":"llama","server":"llama"}]}`, `{}`), Required: required})
		if err != nil {
			t.Fatal(err)
		}
		refs := rules(out, "protected")["llama"]
		if len(refs) != 1 || refs[0].(Object)["kind"] != "InferencePool" || refs[0].(Object)["name"] != "llama-inference-pool" ||
			refs[0].(Object)["group"] != "inference.networking.k8s.io" {
			t.Errorf("backendRefs %v", refs)
		}
		for key := range out.Composed {
			if strings.Contains(key, "-model-") {
				t.Errorf("%s: no backend objects for a pool", key)
			}
		}
		if _, ok := out.Composed["recovery-route"]; ok {
			t.Error("the server doesn't run in the recovery site")
		}
		if !strings.Contains(out.Status.Message, "ModelServer llama doesn't run in the recovery site") {
			t.Errorf("message %q", out.Status.Message)
		}
	})

	t.Run("the Service: another served name, fallbacks, no prefix-cache routing", func(t *testing.T) {
		required := required(false)
		required["server-llama"] = []Object{modelServer("llama", `{"model":{"uri":"hf://x/y","name":"meta-llama/Llama-3.1-8B-Instruct"}}`)}
		required["server-qwen"] = []Object{modelServer("qwen", `{"model":{"uri":"hf://x/q"},"routing":{"prefixCacheAware":false}}`)}
		required["server-mistral"] = []Object{modelServer("mistral", `{"model":{"uri":"hf://x/m"}}`)}
		out, err := Compose(Input{XR: xr(t, `{"models":[{"name":"llama","server":"llama"},{"name":"qwen","server":"qwen"},
			{"name":"mistral","server":"mistral","fallbacks":["gpt"]},{"name":"gpt","endpoint":"https://api.openai.com/v1"}]}`, `{}`), Required: required})
		if err != nil {
			t.Fatal(err)
		}
		got := rules(out, "protected")
		if ref := got["llama"][0].(Object); ref["kind"] != nil || ref["modelNameOverride"] != "meta-llama/Llama-3.1-8B-Instruct" {
			t.Errorf("llama: the Service, renamed: %v", ref)
		}
		if ref := got["qwen"][0].(Object); ref["kind"] != nil {
			t.Errorf("qwen: the Service: %v", ref)
		}
		if refs := got["mistral"]; len(refs) != 2 || refs[0].(Object)["kind"] != nil {
			t.Errorf("mistral: the Service, then its fallback: %v", refs)
		}
		backend := manifest(out.Composed["protected-"+"model-"+sha1hex("llama")[:8]+"-backend"])
		if ep := dig(backend, "spec", "endpoints").([]any)[0]; !equalJSON(ep, `{"fqdn":{"hostname":"llama-kserve-workload-svc.ai.svc","port":8000}}`) {
			t.Errorf("backend %v", ep)
		}
		if _, ok := out.Composed["protected-model-"+sha1hex("llama")[:8]+"-apikey"]; ok {
			t.Error("no provider key for a self-hosted model")
		}
	})

	t.Run("a server that isn't there (yet)", func(t *testing.T) {
		out, _ := Compose(Input{XR: xr(t, `{"models":[{"name":"llama","server":"llama"}]}`, `{}`), Required: required(false)})
		if refs := rules(out, "protected")["llama"]; refs[0].(Object)["kind"] != "InferencePool" || strings.Contains(out.Status.Message, "llama") {
			t.Errorf("unresolved: routed to the pool it will have, no note: %v %q", refs, out.Status.Message)
		}
		required := required(false)
		required["server-llama"] = []Object{}
		out, _ = Compose(Input{XR: xr(t, `{"models":[{"name":"llama","server":"llama"}]}`, `{}`), Required: required})
		if !strings.Contains(out.Status.Message, "no ModelServer llama in ai") {
			t.Errorf("message %q", out.Status.Message)
		}
	})
}

func equalJSON(v any, want string) bool {
	got, _ := json.Marshal(v)
	var a, b any
	_ = json.Unmarshal(got, &a)
	_ = json.Unmarshal([]byte(want), &b)
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}
