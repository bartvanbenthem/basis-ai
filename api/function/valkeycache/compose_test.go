package valkeycache

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func xr(t *testing.T, spec, status string) Object {
	t.Helper()
	var o Object
	if err := json.Unmarshal([]byte(`{"apiVersion":"cache.cndev.nl/v1alpha1","kind":"ValkeyCache",
		"metadata":{"name":"llm-cache","namespace":"demo"},"spec":`+spec+`,"status":`+status+`}`), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

var demo = map[string][]Object{RequiredProject: {{"spec": map[string]any{"locations": map[string]any{"protected": "si-ske-demo"}}}}}

func manifest(c Composed) Object {
	m, _ := dig(c.Object, "spec", "forProvider", "manifest").(Object)
	return m
}

func TestCompose(t *testing.T) {
	NewPassword = func() string { return "generated-password-0123456789abcd" }

	t.Run("places everything in the Project's protected location", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{}`, `{}`), Required: demo})
		if err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"auth-secret", "auth", "cluster", "podmonitor", "prometheusrule", "dashboard"} {
			if _, ok := out.Composed[key]; !ok {
				t.Errorf("missing %s; have %v", key, keys(out.Composed))
			}
		}
		if out.Status.Location != "si-ske-demo" || out.Status.Ready || out.Condition.Reason != "Creating" {
			t.Errorf("status %+v condition %+v", out.Status, out.Condition)
		}
		pc := dig(out.Composed["cluster"].Object, "spec", "providerConfigRef", "name")
		if pc != "si-ske-demo" {
			t.Errorf("providerConfigRef %v", pc)
		}
	})

	t.Run("site recovery runs in the Project's recovery location", func(t *testing.T) {
		both := map[string][]Object{RequiredProject: {{"spec": map[string]any{"locations": map[string]any{
			"protected": "si-ske-demo", "recovery": "onprem-ams"}}}}}
		out, err := Compose(Input{XR: xr(t, `{"site":"recovery"}`, `{}`), Required: both})
		if err != nil {
			t.Fatal(err)
		}
		if out.Status.Location != "onprem-ams" || out.Status.Site != "recovery" {
			t.Errorf("status %+v", out.Status)
		}
		if pc := dig(out.Composed["cluster"].Object, "spec", "providerConfigRef", "name"); pc != "onprem-ams" {
			t.Errorf("providerConfigRef %v", pc)
		}
		// A Project without a recovery location places nothing.
		out, err = Compose(Input{XR: xr(t, `{"site":"recovery"}`, `{}`), Required: demo})
		if err != nil {
			t.Fatal(err)
		}
		if out.Status.Location != "" || out.Condition.Reason != "NoLocation" || out.Composed["cluster"].Object != nil ||
			!strings.Contains(out.Status.Message, "recovery location") {
			t.Errorf("status %+v condition %+v", out.Status, out.Condition)
		}
	})

	t.Run("keeps an existing password", func(t *testing.T) {
		observed := map[string]Object{"auth-secret": {"data": map[string]any{
			"password": base64.StdEncoding.EncodeToString([]byte("kept"))}}}
		out, err := Compose(Input{XR: xr(t, `{}`, `{}`), Observed: observed, Required: demo})
		if err != nil {
			t.Fatal(err)
		}
		uri, _ := base64.StdEncoding.DecodeString(dig(out.Composed["auth-secret"].Object, "data").(map[string]string)["uri"])
		if string(uri) != "valkey://default:kept@valkey-llm-cache.demo.svc:6379" {
			t.Errorf("uri %s", uri)
		}
	})

	t.Run("semantic mode loads valkey-search and its metrics", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"mode":"semantic","resources":{"cpu":"2500m","memory":"2Gi"},"maxMemoryPercent":50}`, `{}`), Required: demo})
		if err != nil {
			t.Fatal(err)
		}
		spec := manifest(out.Composed["cluster"])["spec"].(Object)
		if spec["image"] != BundleImage {
			t.Errorf("image %v", spec["image"])
		}
		args, _ := json.Marshal(spec["containers"])
		// Each word its own argument, the threads as the module's configs:
		// valkey-server reads one "<path> --reader-threads ..." argument as the path.
		if !strings.Contains(string(args), `["--loadmodule","/usr/lib/valkey/libsearch.so","--search.reader-threads","3","--search.writer-threads","3"]`) {
			t.Errorf("containers %s", args)
		}
		exporter, _ := json.Marshal(spec["exporter"])
		if !strings.Contains(string(exporter), "--include-modules-metrics") {
			t.Errorf("exporter %s", exporter)
		}
		if got := dig(spec, "config", "maxmemory"); got != "1024mb" {
			t.Errorf("maxmemory %v", got)
		}
	})

	t.Run("dashboard and alerts are scoped to the cache", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"monitoring":{"prometheusRule":{"excludeRules":["ValkeyCacheLowHitRatio"]}}}`, `{}`), Required: demo})
		if err != nil {
			t.Fatal(err)
		}
		d := out.Composed["dashboard"].Object
		uid, _ := dig(d, "spec", "uid").(string)
		if !strings.HasPrefix(uid, "valkey-") || out.Status.Monitoring == nil || out.Status.Monitoring.DashboardUID != uid {
			t.Errorf("uid %q status %+v", uid, out.Status.Monitoring)
		}
		body, _ := dig(d, "spec", "json").(string)
		if strings.Contains(body, "zz") || !strings.Contains(body, `"Valkey / demo / llm-cache"`) {
			t.Errorf("dashboard placeholders not substituted")
		}
		if sel, _ := dig(d, "spec", "instanceSelector", "matchLabels").(map[string]string); sel["dashboards.paas.cndev.nl/scope"] != "demo" {
			t.Errorf("instanceSelector %v", sel)
		}
		rules, _ := json.Marshal(dig(manifest(out.Composed["prometheusrule"]), "spec", "groups"))
		if strings.Contains(string(rules), "zz") || !strings.Contains(string(rules), `cluster=\"llm-cache\"`) ||
			strings.Contains(string(rules), "ValkeyCacheLowHitRatio") || !strings.Contains(string(rules), "ValkeyCacheDown") {
			t.Errorf("rules %s", rules)
		}
		pm, _ := json.Marshal(manifest(out.Composed["podmonitor"]))
		if !strings.Contains(string(pm), `"targetLabel":"cluster"`) {
			t.Errorf("podmonitor %s", pm)
		}
	})

	t.Run("monitoring off composes no monitor, rules or dashboard", func(t *testing.T) {
		out, err := Compose(Input{XR: xr(t, `{"monitoring":{"enabled":false,"grafanaDashboard":{"enabled":false}}}`, `{}`), Required: demo})
		if err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"podmonitor", "prometheusrule", "dashboard"} {
			if _, ok := out.Composed[key]; ok {
				t.Errorf("%s composed with monitoring off", key)
			}
		}
	})

	t.Run("ready once the copy and the operator report it", func(t *testing.T) {
		observed := map[string]Object{
			"auth":    {"status": map[string]any{"conditions": []any{map[string]any{"type": "Ready", "status": "True"}}}},
			"cluster": {"status": map[string]any{"atProvider": map[string]any{"manifest": map[string]any{"status": map[string]any{"state": "Ready", "shards": 1, "readyShards": 1}}}}},
		}
		out, err := Compose(Input{XR: xr(t, `{}`, `{}`), Observed: observed, Required: demo})
		if err != nil {
			t.Fatal(err)
		}
		if !out.Status.Ready || !out.Condition.Status || !out.Composed["cluster"].Ready || out.Status.ReadyShards != 1 {
			t.Errorf("status %+v", out.Status)
		}
	})

	t.Run("refuses to lose the location of a running cache", func(t *testing.T) {
		observed := map[string]Object{"cluster": {}}
		if _, err := Compose(Input{XR: xr(t, `{}`, `{}`), Observed: observed, Required: map[string][]Object{RequiredProject: {}}}); err == nil {
			t.Error("composed a running cache without a location")
		}
		out, err := Compose(Input{XR: xr(t, `{}`, `{"location":"pinned"}`), Observed: observed, Required: map[string][]Object{RequiredProject: {}}})
		if err != nil || out.Status.Location != "pinned" {
			t.Errorf("pinned location: %v %+v", err, out)
		}
	})
}

func TestHelpers(t *testing.T) {
	for in, want := range map[string]string{"1Gi": "768mb", "512Mi": "384mb"} {
		if got := maxMemory(in, 75); got != want {
			t.Errorf("maxMemory(%s) = %s, want %s", in, got, want)
		}
	}
	for in, want := range map[string]int{"500m": 1, "1": 1, "1.5": 2, "2000m": 2, "100m": 1} {
		if got := searchThreads(in); got != want {
			t.Errorf("searchThreads(%s) = %d, want %d", in, got, want)
		}
	}
}

func keys(m map[string]Composed) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
