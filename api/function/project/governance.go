package project

// Governance and cost of a Project: what it is (classification, environment,
// cost center), what it may spend (budget) and until when it lives
// (expiresAt). Composed:
//
//	the namespaces (control plane and locations): labels
//	  platform.cndev.nl/classification, /environment, /cost-center and, once
//	  past spec.expiresAt, /expired=true. The admission policies read them:
//	  the models a gateway may use, exposure, nothing new in an expired project
//	cost-rules       PrometheusRule basis-cost on the control plane: recording
//	                 rules pricing what runs in the project's locations (CPU and
//	                 memory requests of running pods, volume claims,
//	                 LoadBalancers, gateway tokens per model) with the
//	                 EnvironmentConfig basis-prices, per site; with
//	                 spec.budget, alerts on the month's forecast
//	cost-dashboard   GrafanaDashboard basis-cost in the project's Grafana
//
// The control-plane Prometheus has every location's series (remote write),
// so its rules see both sites. Without basis-prices, no cost rules.

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const requiredPrices = "prices"

// Now is the clock spec.expiresAt is compared with; tests set it.
var Now = time.Now

// hoursPerMonth turns monthly prices into hourly ones (365 * 24 / 12).
const hoursPerMonth = 730

type governance struct {
	classification, environment, costCenter string
	budgetMonthly                           float64
	monthlyTokens                           int64
	expiresAt                               string
	expired                                 bool
	prices                                  Object // basis-prices data; nil without the catalog
}

func newGovernance(spec Object, required map[string][]Object) governance {
	g := governance{
		classification: or(str(spec["classification"]), "internal"),
		environment:    or(str(spec["environment"]), "production"),
		costCenter:     str(spec["costCenter"]),
		expiresAt:      str(spec["expiresAt"]),
	}
	budget := obj(spec["budget"])
	g.budgetMonthly = num(budget["monthly"])
	g.monthlyTokens = int64(num(budget["monthlyTokens"]))
	if t, err := time.Parse("2006-01-02", g.expiresAt); err == nil {
		// Expired at the end of that day, UTC.
		g.expired = !Now().UTC().Before(t.Add(24 * time.Hour))
	}
	if items := required[requiredPrices]; len(items) > 0 {
		g.prices = obj(dig(items[0], "data"))
	}
	return g
}

// labels go on the project's namespaces.
func (g governance) labels() map[string]string {
	l := map[string]string{
		"platform.cndev.nl/classification": g.classification,
		"platform.cndev.nl/environment":    g.environment,
	}
	if v := labelValue(g.costCenter); v != "" {
		l["platform.cndev.nl/cost-center"] = v
	}
	if g.expired {
		l["platform.cndev.nl/expired"] = "true"
	}
	return l
}

var labelUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// labelValue makes a cost center a valid label value (the XRD keeps it close already).
func labelValue(s string) string {
	s = strings.Trim(labelUnsafe.ReplaceAllString(s, "-"), "-._")
	if len(s) > 63 {
		s = strings.TrimRight(s[:63], "-._")
	}
	return s
}

func (g governance) status() Object {
	st := Object{"classification": g.classification, "environment": g.environment, "expired": g.expired}
	if g.costCenter != "" {
		st["costCenter"] = g.costCenter
	}
	if g.expiresAt != "" {
		st["expiresAt"] = g.expiresAt
	}
	if g.budgetMonthly > 0 || g.monthlyTokens > 0 {
		b := Object{}
		if g.budgetMonthly > 0 {
			b["monthly"] = g.budgetMonthly
		}
		if g.monthlyTokens > 0 {
			b["monthlyTokens"] = g.monthlyTokens
		}
		st["budget"] = b
	}
	if g.prices != nil {
		st["currency"] = g.currency()
		st["costMetric"] = "basis:cost_per_hour"
	}
	return st
}

func (g governance) currency() string { return or(str(g.prices["currency"]), "EUR") }

// price is a monthly price from the catalog, per hour.
func (g governance) hourly(key string) float64 { return num(g.prices[key]) / hoursPerMonth }

type tokenPrice struct {
	model         string
	input, output float64 // per 1M tokens
}

// tokenPrices are the catalog's per-model token prices, and its default.
func (g governance) tokenPrices() ([]tokenPrice, tokenPrice) {
	t := obj(g.prices["tokens"])
	def := obj(t["default"])
	d := tokenPrice{input: num(def["input"]), output: num(def["output"])}
	var out []tokenPrice
	models, _ := t["models"].([]any)
	for _, m := range models {
		m := obj(m)
		if name := str(m["model"]); name != "" {
			out = append(out, tokenPrice{model: name, input: num(m["input"]), output: num(m["output"])})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].model < out[j].model })
	return out, d
}

// costRules is PrometheusRule basis-cost: the project's cost per hour by
// site and component, its tokens per hour by model, and the budget alerts.
func (g governance) costRules(s *settings) Object {
	ns := s.ns
	f := func(v float64) string { return strconv.FormatFloat(v, 'g', 8, 64) }
	sel := func(extra string) string { return fmt.Sprintf(`{namespace=%q%s}`, ns, extra) }
	running := fmt.Sprintf(`and on (namespace, pod, site) (kube_pod_status_phase%s == 1)`, sel(`,phase="Running"`))
	cost := func(component, expr string) any {
		return Object{"record": "basis:cost_per_hour", "expr": expr, "labels": Object{"component": component}}
	}
	rules := []any{
		cost("cpu", fmt.Sprintf(`sum by (namespace, site) (kube_pod_container_resource_requests%s %s) * %s`,
			sel(`,resource="cpu"`), running, f(g.hourly("cpu")))),
		cost("memory", fmt.Sprintf(`sum by (namespace, site) (kube_pod_container_resource_requests%s %s) / 1073741824 * %s`,
			sel(`,resource="memory"`), running, f(g.hourly("memory")))),
		cost("storage", fmt.Sprintf(`sum by (namespace, site) (kube_persistentvolumeclaim_resource_requests_storage_bytes%s) / 1073741824 * %s`,
			sel(""), f(g.hourly("storage")))),
		cost("loadbalancer", fmt.Sprintf(`count by (namespace, site) (kube_service_spec_type%s) * %s`,
			sel(`,type="LoadBalancer"`), f(g.hourly("loadBalancer")))),
		Object{"record": "basis:tokens_per_hour", "expr": fmt.Sprintf(
			`sum by (namespace, site, gen_ai_request_model, gen_ai_token_type) (rate(gen_ai_client_token_usage_sum%s[5m])) * 3600`, sel(""))},
	}
	models, def := g.tokenPrices()
	var priced []string
	tokenCost := func(match string, p tokenPrice) any {
		return cost("tokens", fmt.Sprintf(
			`sum by (namespace, site, gen_ai_request_model) (basis:tokens_per_hour%s * %s or basis:tokens_per_hour%s * %s) / 1e6`,
			sel(`,gen_ai_token_type="input",`+match), f(p.input), sel(`,gen_ai_token_type="output",`+match), f(p.output)))
	}
	for _, m := range models {
		rules = append(rules, tokenCost(fmt.Sprintf(`gen_ai_request_model=%q`, m.model), m))
		priced = append(priced, regexp.QuoteMeta(m.model))
	}
	other := `gen_ai_request_model!=""`
	if len(priced) > 0 {
		other = fmt.Sprintf(`gen_ai_request_model!~%q`, strings.Join(priced, "|"))
	}
	rules = append(rules, tokenCost(other, def))
	// The month at the last day's run rate.
	rules = append(rules,
		Object{"record": "basis:cost_monthly_forecast", "expr": fmt.Sprintf(
			`avg_over_time(sum by (namespace) (basis:cost_per_hour%s)[1d:5m]) * %d`, sel(""), hoursPerMonth)},
		Object{"record": "basis:tokens_monthly_forecast", "expr": fmt.Sprintf(
			`avg_over_time(sum by (namespace) (basis:tokens_per_hour%s)[1d:5m]) * %d`, sel(""), hoursPerMonth)},
	)

	var alerts []any
	alert := func(name, expr, severity, summary string) {
		alerts = append(alerts, Object{"alert": name, "expr": expr, "for": "1h",
			"labels":      Object{"severity": severity, "project": s.name},
			"annotations": Object{"summary": summary}})
	}
	if g.budgetMonthly > 0 {
		b := f(g.budgetMonthly)
		alert("BasisBudgetForecastAbove80Percent", fmt.Sprintf(`basis:cost_monthly_forecast%s > 0.8 * %s`, sel(""), b), "warning",
			fmt.Sprintf("Project %s is on track to spend {{ $value | printf \"%%.0f\" }} %s this month, over 80%% of its budget of %s", s.name, g.currency(), b))
		alert("BasisBudgetForecastExceeded", fmt.Sprintf(`basis:cost_monthly_forecast%s > %s`, sel(""), b), "critical",
			fmt.Sprintf("Project %s is on track to spend {{ $value | printf \"%%.0f\" }} %s this month, over its budget of %s", s.name, g.currency(), b))
	}
	if g.monthlyTokens > 0 {
		t := strconv.FormatInt(g.monthlyTokens, 10)
		alert("BasisTokenBudgetForecastAbove80Percent", fmt.Sprintf(`basis:tokens_monthly_forecast%s > 0.8 * %s`, sel(""), t), "warning",
			fmt.Sprintf("Project %s is on track to use {{ $value | humanize }} tokens this month, over 80%% of its %s", s.name, t))
		alert("BasisTokenBudgetForecastExceeded", fmt.Sprintf(`basis:tokens_monthly_forecast%s > %s`, sel(""), t), "critical",
			fmt.Sprintf("Project %s is on track to use {{ $value | humanize }} tokens this month, over its %s", s.name, t))
	}
	groups := []any{Object{"name": "basis-cost", "interval": "1m", "rules": rules}}
	if len(alerts) > 0 {
		groups = append(groups, Object{"name": "basis-budget", "rules": alerts})
	}
	return Object{"apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule", "metadata": s.meta("basis-cost"),
		"spec": Object{"groups": groups}}
}

// costDashboard is the project's cost in its Grafana.
func (g governance) costDashboard(s *settings) Object {
	uid := "basis-cost-" + trunc(sha1hex(s.ns), 12)
	return Object{
		"apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDashboard", "metadata": s.meta("basis-cost"),
		"spec": Object{
			"instanceSelector": Object{"matchLabels": Object{"dashboards.paas.cndev.nl/scope": s.ns}},
			"folder":           "Platform",
			"uid":              uid,
			"resyncPeriod":     "10m",
			"json":             g.dashboardJSON(s, uid),
		},
	}
}

func (g governance) dashboardJSON(s *settings, uid string) string {
	ds := Object{"type": "prometheus", "uid": "${datasource}"}
	sel := fmt.Sprintf(`{namespace=%q}`, s.ns)
	cur := g.currency()
	target := func(expr, legend string) Object {
		return Object{"datasource": ds, "expr": expr, "legendFormat": legend, "refId": "A"}
	}
	stat := func(id, x int, title, expr, unit string) Object {
		return Object{"id": id, "type": "stat", "title": title, "datasource": ds,
			"gridPos":     Object{"h": 5, "w": 6, "x": x, "y": 0},
			"targets":     []any{target(expr, "")},
			"fieldConfig": Object{"defaults": Object{"unit": unit, "decimals": 0}, "overrides": []any{}},
			"options":     Object{"reduceOptions": Object{"calcs": []any{"lastNotNull"}}, "colorMode": "value", "graphMode": "none"}}
	}
	series := func(id, x, y, w int, title, expr, legend, unit string) Object {
		return Object{"id": id, "type": "timeseries", "title": title, "datasource": ds,
			"gridPos": Object{"h": 9, "w": w, "x": x, "y": y},
			"targets": []any{target(expr, legend)},
			"fieldConfig": Object{"defaults": Object{"unit": unit, "custom": Object{"stacking": Object{"mode": "normal"}, "fillOpacity": 20}},
				"overrides": []any{}}}
	}
	money := "currency" + cur
	budget := "vector(0)"
	if g.budgetMonthly > 0 {
		budget = fmt.Sprintf("vector(%s)", strconv.FormatFloat(g.budgetMonthly, 'f', -1, 64))
	}
	panels := []any{
		stat(1, 0, "Forecast this month", "basis:cost_monthly_forecast"+sel, money),
		stat(2, 6, "Monthly budget", budget, money),
		stat(3, 12, "Cost per hour now", "sum(basis:cost_per_hour"+sel+")", money),
		stat(4, 18, "Tokens this month (forecast)", "basis:tokens_monthly_forecast"+sel, "short"),
		series(5, 0, 5, 12, "Cost per hour by component", "sum by (component) (basis:cost_per_hour"+sel+")", "{{component}}", money),
		series(6, 12, 5, 12, "Cost per hour by site", "sum by (namespace, site) (basis:cost_per_hour"+sel+")", "{{site}}", money),
		series(7, 0, 14, 12, "Token cost per hour by model", `sum by (gen_ai_request_model) (basis:cost_per_hour{namespace="`+s.ns+`",component="tokens"})`,
			"{{gen_ai_request_model}}", money),
		series(8, 12, 14, 12, "Tokens per hour by model", "sum by (gen_ai_request_model, gen_ai_token_type) (basis:tokens_per_hour"+sel+")",
			"{{gen_ai_request_model}} {{gen_ai_token_type}}", "short"),
	}
	d := Object{
		"uid": uid, "title": fmt.Sprintf("Cost: %s", s.name), "schemaVersion": 39, "refresh": "5m",
		"time":       Object{"from": "now-7d", "to": "now"},
		"tags":       []any{"basis", "cost"},
		"templating": Object{"list": []any{Object{"name": "datasource", "type": "datasource", "query": "prometheus", "current": Object{"text": "prometheus", "value": "prometheus"}}}},
		"panels":     panels,
	}
	raw, _ := json.Marshal(d)
	return string(raw)
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case int:
		return float64(x)
	case string:
		f, err := strconv.ParseFloat(x, 64)
		if err == nil && !math.IsNaN(f) {
			return f
		}
	}
	return 0
}
