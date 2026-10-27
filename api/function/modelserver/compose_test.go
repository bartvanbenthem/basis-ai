package modelserver

import (
	"encoding/json"
	"strings"
	"testing"
)

func xr(t *testing.T, spec, status string) Object {
	t.Helper()
	var o Object
	if err := json.Unmarshal([]byte(`{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"ModelServer",
		"metadata":{"name":"llama","namespace":"ai"},"spec":`+spec+`,"status":`+status+`}`), &o); err != nil {
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

// observedServer is an Object whose LLMInferenceService the location reports with ready.
func observedServer(ready string, conditions ...any) Object {
	conds := append([]any{map[string]any{"type": "Ready", "status": ready}}, conditions...)
	return Object{"status": map[string]any{"atProvider": map[string]any{"manifest": map[string]any{
		"kind": "LLMInferenceService", "status": map[string]any{"conditions": conds}}}}}
}

const model = `"model":{"uri":"hf://meta-llama/Llama-3.1-8B-Instruct"}`

func TestCompose(t *testing.T) {
	t.Run("vLLM with llm-d's scheduler in the protected location", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{`+model+`}`, `{}`), Required: required(true)})
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := out.Composed["recovery-server"]; ok {
			t.Error("recovery site without recovery.enabled")
		}
		srv := manifest(out.Composed["protected-server"])
		if srv["kind"] != "LLMInferenceService" || dig(out.Composed["protected-server"].Object, "spec", "providerConfigRef", "name") != "dc-a" {
			t.Fatalf("server %v", out.Composed["protected-server"].Object)
		}
		spec := srv["spec"].(Object)
		if m := spec["model"].(Object); m["name"] != "llama" || m["uri"] != "hf://meta-llama/Llama-3.1-8B-Instruct" {
			t.Errorf("model %v: served as the ModelServer's name", m)
		}
		if spec["replicas"] != 1 || spec["parallelism"] != nil {
			t.Errorf("replicas %v, parallelism %v", spec["replicas"], spec["parallelism"])
		}
		if l := spec["labels"].(map[string]string); len(l) != 1 || l["ai.cndev.nl/modelserver"] != "llama" {
			t.Errorf("labels %v: none of KServe's own (app.kubernetes.io/part-of finds its Deployments)", l)
		}
		if _, ok := dig(spec, "router", "scheduler").(Object); !ok {
			t.Errorf("prefix-cache-aware routing needs the scheduler: %v", spec["router"])
		}
		main := dig(spec, "template", "containers").([]any)[0].(Object)
		res := main["resources"].(Object)
		if dig(res, "requests", "nvidia.com/gpu") != "1" || dig(res, "limits", "nvidia.com/gpu") != "1" || dig(res, "limits", "memory") != "16Gi" {
			t.Errorf("resources %v", res)
		}
		if main["image"] != nil || main["securityContext"] != nil || main["args"] != nil {
			t.Errorf("KServe's image and flags by default: %v", main)
		}
		if out.Status.Endpoint != "http://llama-kserve-workload-svc.ai.svc:8000/v1" || out.Status.InferencePool != "llama-inference-pool" ||
			out.Status.Model != "llama" || out.Status.Ready {
			t.Errorf("status %+v", out.Status)
		}
		if out.Condition.Reason != "Creating" || !strings.Contains(out.Status.Message, "waiting for KServe in dc-a") {
			t.Errorf("condition %+v", out.Condition)
		}
		if out.Composed["dashboard"].Object["kind"] != "GrafanaDashboard" || out.Status.DashboardUID == "" {
			t.Errorf("dashboard %v", out.Composed["dashboard"].Object)
		}
	})

	t.Run("served name, GPUs, image, flags and scheduling", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"model":{"uri":"pvc://models/llama","name":"meta-llama/Llama-3.1-70B"},"replicas":3,
			"resources":{"gpus":4,"gpuResource":"amd.com/gpu","memory":"200Gi"},"image":"rocm/vllm:latest",
			"args":["--max-model-len=8192"],"routing":{"prefixCacheAware":false},
			"scheduling":{"nodeSelector":{"gpu":"mi300"},"tolerations":[{"key":"gpu","operator":"Exists","effect":"NoSchedule"}]}}`, `{}`),
			Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		spec := manifest(out.Composed["protected-server"])["spec"].(Object)
		if dig(spec, "model", "name") != "meta-llama/Llama-3.1-70B" || spec["replicas"] != 3 || dig(spec, "parallelism", "tensor") != 4 {
			t.Errorf("spec %v", spec)
		}
		if spec["router"] != nil || out.Status.InferencePool != "" {
			t.Errorf("no scheduler without prefixCacheAware: %v, %q", spec["router"], out.Status.InferencePool)
		}
		tpl := spec["template"].(Object)
		main := tpl["containers"].([]any)[0].(Object)
		if main["image"] != "rocm/vllm:latest" || len(main["args"].([]any)) != 1 || dig(main, "resources", "limits", "amd.com/gpu") != "4" {
			t.Errorf("main %v", main)
		}
		if tpl["nodeSelector"].(map[string]string)["gpu"] != "mi300" || len(tpl["tolerations"].([]any)) != 1 {
			t.Errorf("template %v", tpl)
		}
	})

	t.Run("CPU only", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{`+model+`,"resources":{"gpus":0},"image":"vllm/vllm-openai-cpu:v0.23.0"}`, `{}`), Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		main := dig(manifest(out.Composed["protected-server"]), "spec", "template", "containers").([]any)[0].(Object)
		for _, k := range []string{"requests", "limits"} {
			for r := range dig(main, "resources", k).(Object) {
				if strings.Contains(r, "gpu") {
					t.Errorf("%s %s without GPUs", k, r)
				}
			}
		}
		if dig(main, "securityContext", "runAsNonRoot") != false {
			t.Errorf("the CPU image runs as root: %v", main["securityContext"])
		}
	})

	t.Run("a Hugging Face token, through a ServiceAccount", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"model":{"uri":"hf://meta-llama/Llama-3.1-8B-Instruct","tokenSecretRef":{"name":"hf"}}}`, `{}`), Required: required(false)})
		if err != nil {
			t.Fatal(err)
		}
		token := out.Composed["protected-token"].Object
		ref := dig(token, "spec", "references").([]any)[0].(Object)
		if dig(ref, "patchesFrom", "name") != "hf" || dig(ref, "patchesFrom", "fieldPath") != "data.HF_TOKEN" || ref["toFieldPath"] != "data.HF_TOKEN" {
			t.Errorf("token copy %v", ref)
		}
		if m := manifest(out.Composed["protected-token"]); m["data"] != nil || m["stringData"] != nil {
			t.Errorf("token data in the Object spec: %v", m)
		}
		sa := manifest(out.Composed["protected-serviceaccount"])
		if sa["kind"] != "ServiceAccount" || dig(sa, "metadata", "name") != "llama-model" ||
			dig(sa["secrets"].([]any)[0], "name") != "llama-model-token" {
			t.Errorf("service account %v", sa)
		}
		if n := dig(manifest(out.Composed["protected-server"]), "spec", "template", "serviceAccountName"); n != "llama-model" {
			t.Errorf("serviceAccountName %v", n)
		}
	})

	t.Run("both sites, ready; a stopped standby", func(t *testing.T) {
		observed := map[string]Object{
			"protected-server": observedServer("True"),
			"recovery-server":  observedServer("False"),
		}
		out, err := Compose(Input{XR: xr(t, `{`+model+`,"replicas":2,"recovery":{"enabled":true,"replicas":0}}`,
			`{"sites":[{"site":"protected","location":"pinned"}]}`), Observed: observed, Required: required(true)})
		if err != nil {
			t.Fatal(err)
		}
		if dig(out.Composed["protected-server"].Object, "spec", "providerConfigRef", "name") != "pinned" ||
			dig(out.Composed["recovery-server"].Object, "spec", "providerConfigRef", "name") != "dc-b" {
			t.Error("locations: pinned, else the Project's")
		}
		if r := dig(manifest(out.Composed["recovery-server"]), "spec", "replicas"); r != 0 {
			t.Errorf("standby replicas %v", r)
		}
		if _, ok := out.Composed["recovery-prometheusrule"]; ok {
			t.Error("no alerts for a stopped site")
		}
		if !out.Status.Ready || !out.Condition.Status || len(out.Status.Sites) != 2 || !out.Status.Sites[1].Ready {
			t.Errorf("status %+v", out.Status)
		}
	})

	t.Run("not ready: KServe's reason; not applied: KServe missing", func(t *testing.T) {
		out, _ := Compose(Input{XR: xr(t, `{`+model+`}`, `{}`), Required: required(false), Observed: map[string]Object{
			"protected-server": observedServer("False", map[string]any{"type": "MainWorkloadReady", "status": "False", "message": "0/1 nodes have nvidia.com/gpu"}),
		}})
		if out.Status.Ready || !strings.Contains(out.Status.Message, "MainWorkloadReady: 0/1 nodes have nvidia.com/gpu") {
			t.Errorf("message %q", out.Status.Message)
		}
		out, _ = Compose(Input{XR: xr(t, `{`+model+`}`, `{}`), Required: required(false), Observed: map[string]Object{
			"protected-server": {"status": map[string]any{"conditions": []any{map[string]any{"type": "Synced", "status": "False", "message": "no matches for kind"}}}},
		}})
		if out.Condition.Reason != "Waiting" || !strings.Contains(out.Status.Message, "is KServe installed there?") {
			t.Errorf("condition %+v", out.Condition)
		}
	})

	t.Run("no Project location", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{`+model+`}`, `{}`)})
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := out.Composed["protected-server"]; ok || out.Condition.Reason != "Waiting" {
			t.Errorf("composed %v, condition %+v", len(out.Composed), out.Condition)
		}
	})

	t.Run("monitoring", func(t *testing.T) {
		out, _ := Compose(Input{XR: xr(t, `{`+model+`,"alerts":{"waitingRequests":5}}`, `{}`), Required: required(false)})
		pm := manifest(out.Composed["protected-podmonitor"])
		if dig(pm, "spec", "selector", "matchLabels", "kserve.io/component") != "workload" {
			t.Errorf("podmonitor selector %v", dig(pm, "spec", "selector"))
		}
		rules := dig(manifest(out.Composed["protected-prometheusrule"]), "spec", "groups").([]any)[0].(Object)["rules"].([]any)
		if len(rules) != 4 || !strings.Contains(rules[1].(Object)["expr"].(string), "> 5") {
			t.Errorf("rules %v", rules)
		}
		var d map[string]any
		if err := json.Unmarshal([]byte(dig(out.Composed["dashboard"].Object, "spec", "json").(string)), &d); err != nil || d["uid"] != out.Status.DashboardUID {
			t.Errorf("dashboard json: %v %v", err, d["uid"])
		}
		out, _ = Compose(Input{XR: xr(t, `{`+model+`,"alerts":{"disabled":true}}`, `{}`), Required: required(false)})
		if _, ok := out.Composed["protected-prometheusrule"]; ok {
			t.Error("alerts disabled")
		}
	})
}

func TestServedName(t *testing.T) {
	if n := ServedName(xr(t, `{`+model+`}`, `{}`)); n != "llama" {
		t.Errorf("default %q", n)
	}
	if n := ServedName(xr(t, `{"model":{"uri":"hf://x/y","name":"x/y"}}`, `{}`)); n != "x/y" {
		t.Errorf("spec.model.name %q", n)
	}
}
