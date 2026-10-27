package project

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

var prices = Object{"data": Object{"currency": "EUR", "cpu": 73.0, "memory": 7.3, "storage": 0.73, "loadBalancer": 14.6,
	"tokens": Object{"default": Object{"input": 1.0, "output": 2.0},
		"models": []any{Object{"model": "openai/gpt-oss-120b", "input": 0.5, "output": 1.0}}}}}

// governed composes a project whose namespace exists, with the price catalog.
func governed(t *testing.T, spec string) *Output {
	t.Helper()
	return Compose(Input{XR: xr(t, "demo", spec, `{}`),
		Observed: map[string]Object{"namespace": {"status": Object{"phase": "Active"}}},
		Required: map[string][]Object{requiredPrices: {prices}, "location-dc-a": {{"spec": Object{}}}}})
}

func TestGovernanceLabelsAndStatus(t *testing.T) {
	Now = func() time.Time { return time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC) }
	defer func() { Now = time.Now }()

	out := governed(t, `{"locations":{"protected":"dc-a"},"classification":"confidential","environment":"sandbox",
		"costCenter":"CC 4711","budget":{"monthly":2500,"monthlyTokens":50000000},"expiresAt":"2026-10-22"}`)
	labels := dig(out.Composed["namespace"].Object, "metadata", "labels").(Object)
	if labels["platform.cndev.nl/classification"] != "confidential" || labels["platform.cndev.nl/environment"] != "sandbox" ||
		labels["platform.cndev.nl/cost-center"] != "CC-4711" {
		t.Errorf("labels %v", labels)
	}
	// The last day itself isn't over yet.
	if _, ok := labels["platform.cndev.nl/expired"]; ok {
		t.Error("expired on its last day")
	}
	g := out.Status["governance"].(Object)
	if g["costCenter"] != "CC 4711" || g["expired"] != false || g["currency"] != "EUR" || dig(g, "budget", "monthly") != 2500.0 {
		t.Errorf("governance status %v", g)
	}

	Now = func() time.Time { return time.Date(2026, 10, 23, 0, 0, 1, 0, time.UTC) }
	out = governed(t, `{"locations":{"protected":"dc-a"},"expiresAt":"2026-10-22"}`)
	labels = dig(out.Composed["namespace"].Object, "metadata", "labels").(Object)
	if labels["platform.cndev.nl/expired"] != "true" || !strings.Contains(out.Status["message"].(string), "expired on 2026-10-22") {
		t.Errorf("labels %v, message %q", labels, out.Status["message"])
	}
	// Defaults: internal, production.
	if l := dig(out.Composed["namespace"].Object, "metadata", "labels").(Object); l["platform.cndev.nl/classification"] != "internal" ||
		l["platform.cndev.nl/environment"] != "production" {
		t.Errorf("defaults %v", l)
	}
}

func TestCostRules(t *testing.T) {
	out := governed(t, `{"locations":{"protected":"dc-a"},"budget":{"monthly":2500}}`)
	rules, ok := out.Composed["cost-rules"]
	if !ok {
		t.Fatal("no cost rules with the price catalog")
	}
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(rules.Object)
	s := buf.String()
	for _, want := range []string{
		// 73 per vCPU-month is 0.1 per hour; running pods only.
		`kube_pod_container_resource_requests{namespace=\"demo\",resource=\"cpu\"} and on (namespace, pod, site) (kube_pod_status_phase{namespace=\"demo\",phase=\"Running\"} == 1)) * 0.1`,
		`count by (namespace, site) (kube_service_spec_type{namespace=\"demo\",type=\"LoadBalancer\"}) * 0.02`,
		// The priced model, and every other model at the default price.
		`gen_ai_request_model=\"openai/gpt-oss-120b\"} * 0.5 or basis:tokens_per_hour{namespace=\"demo\",gen_ai_token_type=\"output\",gen_ai_request_model=\"openai/gpt-oss-120b\"} * 1)`,
		`gen_ai_request_model!~\"openai/gpt-oss-120b\"} * 1 or`,
		`"alert":"BasisBudgetForecastExceeded"`,
		`"expr":"basis:cost_monthly_forecast{namespace=\"demo\"} > 2500"`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("cost rules lack %s\n%s", want, s)
		}
	}
	if strings.Contains(s, "BasisTokenBudget") {
		t.Error("token alerts without budget.monthlyTokens")
	}
	if _, ok := out.Composed["cost-dashboard"]; !ok {
		t.Error("no cost dashboard")
	}
	// The control-plane Prometheus evaluates them.
	if sel := dig(out.Composed["prometheus"].Object, "spec", "ruleNamespaceSelector", "matchLabels"); sel.(Object)["kubernetes.io/metadata.name"] != "demo" {
		t.Errorf("rule namespace selector %v", sel)
	}

	// Without the catalog: no cost rules, no rule selector on the control plane.
	bare := Compose(Input{XR: xr(t, "demo", `{"locations":{"protected":"dc-a"}}`, `{}`),
		Observed: map[string]Object{"namespace": {"status": Object{"phase": "Active"}}}})
	if _, ok := bare.Composed["cost-rules"]; ok {
		t.Error("cost rules without basis-prices")
	}
	if dig(bare.Composed["prometheus"].Object, "spec", "ruleSelector") != nil {
		t.Error("rule selector on the control plane without cost rules")
	}
	if Requirements(xr(t, "demo", `{}`, `{}`), nil)[requiredPrices].Name != "basis-prices" {
		t.Error("the price catalog isn't required")
	}
}
