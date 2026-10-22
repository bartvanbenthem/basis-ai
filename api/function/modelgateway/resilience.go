package modelgateway

// Resilience and monitoring of a gateway:
//
//   - fallbacks: a model's route rule also lists its spec.models[].fallbacks,
//     each a priority lower; retries move on to the next priority after
//     spec.retry.attempts on one (Envoy's previous-priorities retry)
//   - retries on the Gateways' BackendTrafficPolicy, so they never depend on
//     the rate limit store the token caps need
//   - per-minute caps (requests and tokens, per client and for the gateway)
//     next to the monthly ones, on the route
//   - metrics: Agent Router's gen_ai_* (latency, time to first token, tokens,
//     errors) and Envoy's retries and responses, labelled with the gateway and
//     the model; alerts per site on latency and errors; a dashboard in the
//     Project's Grafana

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
)

// modelObject is the name of a model's Backend, AIServiceBackend and policies.
func (c *composition) modelObject(name string) string { return c.name + "-model-" + sha1hex(name)[:8] }

// backendRefs are a model's backend and, a priority lower each, its fallbacks'.
func (c *composition) backendRefs(m Model, byName map[string]Model) []any {
	ref := func(m Model, priority int) Object {
		r := Object{"name": c.modelObject(m.Name)}
		if m.UpstreamModel != "" {
			r["modelNameOverride"] = m.UpstreamModel
		} else if priority > 0 {
			// A fallback gets the request for another model: name its own.
			r["modelNameOverride"] = m.Name
		}
		if priority > 0 {
			r["priority"] = priority
		}
		return r
	}
	refs := []any{ref(m, 0)}
	for _, f := range c.spec.fallbacks(m) {
		// Only the fallbacks this site serves.
		if fb, ok := byName[f]; ok {
			refs = append(refs, ref(fb, len(refs)))
		}
	}
	return refs
}

// retryPolicy is the Gateways' retry: attempts per model on the retried
// statuses and connection failures, with backoff; with fallbacks, moving to
// the next one after that many. Nil when nothing is retried.
func (c *composition) retryPolicy() Object {
	attempts := c.spec.attempts()
	priorities := 1 + c.spec.maxFallbacks()
	retries := attempts*priorities - 1
	if retries <= 0 {
		return nil
	}
	codes := []any{}
	for _, code := range c.spec.retryOn() {
		codes = append(codes, code)
	}
	perRetry := Object{"backOff": Object{"baseInterval": "250ms", "maxInterval": "5s"}}
	if c.spec.Retry != nil && c.spec.Retry.PerTryTimeout != "" {
		perRetry["timeout"] = c.spec.Retry.PerTryTimeout
	}
	retry := Object{
		"numRetries": retries,
		"retryOn": Object{
			"triggers":        []any{"connect-failure", "reset", "retriable-status-codes"},
			"httpStatusCodes": codes,
		},
		"perRetry": perRetry,
	}
	if priorities > 1 {
		retry["numAttemptsPerPriority"] = attempts
	}
	return retry
}

// minuteRules are the per-minute caps, per client and for the gateway: a
// request counts 1 when it arrives, a token cap is charged with each
// response's total tokens.
func (c *composition) minuteRules(tokenCost Object) []any {
	var rules []any
	add := func(selectors []any, p PerMinute) {
		if p.RequestsPerMinute > 0 {
			r := Object{"limit": Object{"requests": p.RequestsPerMinute, "unit": "Minute"}, "shared": true}
			if selectors != nil {
				r["clientSelectors"] = selectors
			}
			rules = append(rules, r)
		}
		if p.TokensPerMinute > 0 {
			r := Object{"limit": Object{"requests": p.TokensPerMinute, "unit": "Minute"}, "cost": tokenCost, "shared": true}
			if selectors != nil {
				r["clientSelectors"] = selectors
			}
			rules = append(rules, r)
		}
	}
	for _, cl := range c.spec.clientList() {
		if !cl.expired() {
			add([]any{Object{"headers": []any{Object{"name": ClientHeader, "type": "Exact", "value": cl.Name}}}}, cl.PerMinute)
		}
	}
	add(nil, c.spec.RateLimit)
	return rules
}

// envoyMetrics are the Envoy statistics the dashboard and alerts use; the
// rest (thousands of series) isn't kept.
const envoyMetrics = `envoy_cluster_upstream_rq_(retry|retry_success|retry_overflow|xx|timeout)|envoy_http_downstream_rq_xx|envoy_cluster_ratelimit_over_limit`

// podMonitor scrapes the gateway's Envoy proxies: Agent Router's gen_ai_*
// metrics from the extproc sidecar and a few Envoy statistics, every series
// labelled with the gateway (the exposed Gateway's proxies too) and Envoy's
// with the model of its route rule.
func (c *composition) podMonitor(gateways []any, models []Model) Object {
	gateway := Object{
		"sourceLabels": []any{"__meta_kubernetes_pod_label_gateway_envoyproxy_io_owning_gateway_name"},
		"regex":        "(.+?)(-external)?", "targetLabel": "gateway", "replacement": "$1",
	}
	// Agent Router turns the AIGatewayRoute into HTTPRoute <name>, a rule
	// per model in the order the composition writes them (sorted by name).
	keep := []any{Object{"sourceLabels": []any{"__name__"}, "regex": envoyMetrics, "action": "keep"}}
	for i, m := range models {
		keep = append(keep, Object{
			"sourceLabels": []any{"envoy_cluster_name"},
			"regex":        regexp.QuoteMeta(fmt.Sprintf("httproute/%s/%s/rule/%d", c.ns, c.name, i)),
			"targetLabel":  "model", "replacement": m.Name,
		})
	}
	return Object{
		"apiVersion": "monitoring.coreos.com/v1", "kind": "PodMonitor", "metadata": c.meta(c.name + "-tokens"),
		"spec": Object{
			"selector": Object{"matchExpressions": []any{Object{
				"key": "gateway.envoyproxy.io/owning-gateway-name", "operator": "In", "values": gateways}}},
			"podMetricsEndpoints": []any{
				// The ai-gateway-extproc sidecar's admin port (no named port).
				Object{"targetPort": ExtProcMetricsPort, "path": "/metrics", "interval": "30s", "relabelings": []any{gateway}},
				Object{"port": "metrics", "path": "/stats/prometheus", "interval": "30s", "relabelings": []any{gateway},
					"metricRelabelings": keep},
			},
		},
	}
}

// alertRules are the gateway's alerts, evaluated by the Project's Prometheus
// in each site: a model slow (95th percentile of the request duration, and
// of the time to first token when streamed) or failing, and the gateway's
// metrics gone.
func (c *composition) alertRules() Object {
	a := c.spec.Alerts
	sel := fmt.Sprintf(`namespace=%q,gateway=%q`, c.ns, c.name)
	f := func(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
	p95 := func(metric string) string {
		return fmt.Sprintf(`histogram_quantile(0.95, sum by (le, gen_ai_original_model) (rate(%s_bucket{%s}[10m])))`, metric, sel)
	}
	labels := Object{"severity": "warning", "gateway": c.name}
	rules := []any{
		Object{"alert": "BasisGatewaySlow", "for": "15m", "labels": labels,
			"expr": fmt.Sprintf(`%s > %s`, p95("gen_ai_server_request_duration_seconds"), f(a.latency())),
			"annotations": Object{"summary": fmt.Sprintf("Gateway %s: 95%% of %s requests take up to {{ $value | humanizeDuration }} (threshold %ss)",
				c.name, "{{ $labels.gen_ai_original_model }}", f(a.latency()))}},
		Object{"alert": "BasisGatewaySlowFirstToken", "for": "15m", "labels": labels,
			"expr": fmt.Sprintf(`%s > %s`, p95("gen_ai_server_time_to_first_token_seconds"), f(a.firstToken())),
			"annotations": Object{"summary": fmt.Sprintf("Gateway %s: 95%% of streamed %s requests wait up to {{ $value | humanizeDuration }} for the first token (threshold %ss)",
				c.name, "{{ $labels.gen_ai_original_model }}", f(a.firstToken()))}},
		Object{"alert": "BasisGatewayErrors", "for": "10m", "labels": labels,
			"expr": fmt.Sprintf(`100 * sum by (gen_ai_original_model) (rate(gen_ai_server_request_duration_seconds_count{%s,error_type!=""}[10m]))
  / sum by (gen_ai_original_model) (rate(gen_ai_server_request_duration_seconds_count{%s}[10m])) > %s`, sel, sel, f(a.errorPercent())),
			"annotations": Object{"summary": fmt.Sprintf("Gateway %s: {{ $value | printf \"%%.1f\" }}%% of %s requests fail (threshold %s%%)",
				c.name, "{{ $labels.gen_ai_original_model }}", f(a.errorPercent()))}},
		Object{"alert": "BasisGatewayMetricsMissing", "for": "10m", "labels": labels,
			"expr":        fmt.Sprintf(`absent(up{%s})`, sel),
			"annotations": Object{"summary": fmt.Sprintf("Gateway %s: no metrics from its proxies in this site", c.name)}},
	}
	return Object{"apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule", "metadata": c.meta(c.name + "-gateway-alerts"),
		"spec": Object{"groups": []any{Object{"name": fmt.Sprintf("gateway/%s/%s", c.ns, c.name), "rules": rules}}}}
}

// dashboard is the gateway's dashboard in the Project's Grafana (control
// plane): requests, errors, latency, time to first token and per output
// token, tokens, retries and rate-limited requests, per model and site.
func (c *composition) dashboard() Object {
	uid := "basis-gw-" + sha1hex(c.ns + "/" + c.name)[:12]
	return Object{
		"apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDashboard", "metadata": c.meta(c.name + "-gateway"),
		"spec": Object{
			"instanceSelector": Object{"matchLabels": Object{"dashboards.paas.cndev.nl/scope": c.ns}},
			"folder":           "Model gateways",
			"uid":              uid,
			"resyncPeriod":     "10m",
			"json":             c.dashboardJSON(uid),
		},
	}
}

func (c *composition) dashboardJSON(uid string) string {
	ds := Object{"type": "prometheus", "uid": "${datasource}"}
	sel := fmt.Sprintf(`namespace=%q,gateway=%q,site=~"$site"`, c.ns, c.name)
	id := 0
	panel := func(title, unit string, x, y, w int, targets ...Object) Object {
		id++
		for i, t := range targets {
			t["datasource"], t["refId"] = ds, string(rune('A'+i))
		}
		ts := make([]any, len(targets))
		for i, t := range targets {
			ts[i] = t
		}
		return Object{"id": id, "type": "timeseries", "title": title, "datasource": ds,
			"gridPos": Object{"h": 8, "w": w, "x": x, "y": y}, "targets": ts,
			"fieldConfig": Object{"defaults": Object{"unit": unit}, "overrides": []any{}}}
	}
	q := func(expr, legend string) Object { return Object{"expr": expr, "legendFormat": legend} }
	p := func(quantile, metric string) string {
		return fmt.Sprintf(`histogram_quantile(%s, sum by (le, gen_ai_original_model) (rate(%s_bucket{%s}[$__rate_interval])))`, quantile, metric, sel)
	}
	rate := func(metric, extra string) string {
		return fmt.Sprintf(`sum by (gen_ai_original_model) (rate(%s{%s%s}[$__rate_interval]))`, metric, sel, extra)
	}
	panels := []any{
		panel("Requests per second", "reqps", 0, 0, 12, q(rate("gen_ai_server_request_duration_seconds_count", ""), "{{gen_ai_original_model}}")),
		panel("Failed requests", "percentunit", 12, 0, 12, q(rate("gen_ai_server_request_duration_seconds_count", `,error_type!=""`)+" / "+
			rate("gen_ai_server_request_duration_seconds_count", ""), "{{gen_ai_original_model}}")),
		panel("Request duration (p50, p95)", "s", 0, 8, 12,
			q(p("0.5", "gen_ai_server_request_duration_seconds"), "p50 {{gen_ai_original_model}}"),
			q(p("0.95", "gen_ai_server_request_duration_seconds"), "p95 {{gen_ai_original_model}}")),
		panel("Time to first token (p50, p95; streamed)", "s", 12, 8, 12,
			q(p("0.5", "gen_ai_server_time_to_first_token_seconds"), "p50 {{gen_ai_original_model}}"),
			q(p("0.95", "gen_ai_server_time_to_first_token_seconds"), "p95 {{gen_ai_original_model}}")),
		panel("Time per output token (p95; streamed)", "s", 0, 16, 12,
			q(p("0.95", "gen_ai_server_time_per_output_token_seconds"), "{{gen_ai_original_model}}")),
		panel("Tokens per second", "short", 12, 16, 12, q(
			fmt.Sprintf(`sum by (gen_ai_original_model, gen_ai_token_type) (rate(gen_ai_client_token_usage_sum{%s}[$__rate_interval]))`, sel),
			"{{gen_ai_original_model}} {{gen_ai_token_type}}")),
		panel("Retries and fallbacks per second", "reqps", 0, 24, 12,
			q(fmt.Sprintf(`sum by (model) (rate(envoy_cluster_upstream_rq_retry{%s}[$__rate_interval]))`, sel), "retried {{model}}"),
			q(fmt.Sprintf(`sum by (model) (rate(envoy_cluster_upstream_rq_retry_success{%s}[$__rate_interval]))`, sel), "recovered {{model}}")),
		panel("Responses to clients", "reqps", 12, 24, 12,
			q(fmt.Sprintf(`sum by (envoy_response_code_class) (rate(envoy_http_downstream_rq_xx{%s}[$__rate_interval]))`, sel), "{{envoy_response_code_class}}xx"),
			q(fmt.Sprintf(`sum(rate(envoy_cluster_ratelimit_over_limit{%s}[$__rate_interval]))`, sel), "rate limited")),
	}
	d := Object{
		"uid": uid, "title": fmt.Sprintf("Model gateway: %s", c.name), "schemaVersion": 39, "refresh": "1m",
		"time": Object{"from": "now-6h", "to": "now"}, "tags": []any{"basis", "gateway"},
		"templating": Object{"list": []any{
			Object{"name": "datasource", "type": "datasource", "query": "prometheus", "current": Object{"text": "prometheus", "value": "prometheus"}},
			Object{"name": "site", "type": "custom", "query": "protected,recovery", "includeAll": true, "multi": true,
				"current": Object{"text": "All", "value": "$__all"}, "allValue": ".*"},
		}},
		"panels": panels,
	}
	raw, _ := json.Marshal(d)
	return string(raw)
}

// sortedModels are spec.models by name: the order of the route's rules.
func sortedModels(models []Model) []Model {
	out := append([]Model(nil), models...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
