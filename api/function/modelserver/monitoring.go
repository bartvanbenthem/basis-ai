package modelserver

// Monitoring of a server, from vLLM's own metrics (vllm:*): requests running
// and waiting, KV cache use, prefix cache hits (what prefix-cache-aware
// routing raises), latency and tokens. Scraped in each site by the Project's
// Prometheus, alerted on there, and shown in a dashboard in the Project's
// Grafana.

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// podMonitor scrapes vLLM in the server's pods (KServe's workload labels; the
// scheduler's pods have another component), every series labelled with the
// server. Only vllm:* is kept.
func (c *composition) podMonitor() Object {
	return Object{
		"apiVersion": "monitoring.coreos.com/v1", "kind": "PodMonitor", "metadata": c.meta(c.name + "-vllm"),
		"spec": Object{
			"selector": Object{"matchLabels": Object{
				"app.kubernetes.io/name":    c.name,
				"app.kubernetes.io/part-of": "llminferenceservice",
				"kserve.io/component":       "workload",
			}},
			"podMetricsEndpoints": []any{Object{
				// vLLM's API port (KServe's container has no named port).
				"targetPort": Port, "path": "/metrics", "interval": "30s",
				"relabelings": []any{Object{"targetLabel": "server", "replacement": c.name}},
				"metricRelabelings": []any{
					Object{"sourceLabels": []any{"__name__"}, "regex": "vllm:.*", "action": "keep"},
				},
			}},
		},
	}
}

// alertRules are the server's alerts in a site with replicas: none of them
// up, requests queueing, the KV cache full (requests get preempted), the
// first token slow.
func (c *composition) alertRules() Object {
	a := c.spec.Alerts
	sel := fmt.Sprintf(`namespace=%q,server=%q`, c.ns, c.name)
	f := func(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
	labels := Object{"severity": "warning", "server": c.name}
	rules := []any{
		// Loading a large model takes a while: 15 minutes before it counts.
		Object{"alert": "BasisModelServerDown", "for": "15m", "labels": labels,
			"expr":        fmt.Sprintf(`(sum(up{%s}) or vector(0)) < 1`, sel),
			"annotations": Object{"summary": fmt.Sprintf("Model server %s: no replica serves in this site", c.name)}},
		Object{"alert": "BasisModelServerQueueing", "for": "10m", "labels": labels,
			"expr": fmt.Sprintf(`sum(vllm:num_requests_waiting{%s}) > %d`, sel, a.waiting()),
			"annotations": Object{"summary": fmt.Sprintf("Model server %s: {{ $value }} requests wait for a slot (threshold %d); add replicas",
				c.name, a.waiting())}},
		Object{"alert": "BasisModelServerKVCacheFull", "for": "15m", "labels": labels,
			"expr": fmt.Sprintf(`100 * max(vllm:kv_cache_usage_perc{%s}) > %s`, sel, f(a.kvCachePercent())),
			"annotations": Object{"summary": fmt.Sprintf("Model server %s: a replica's KV cache is {{ $value | printf \"%%.0f\" }}%% full (threshold %s%%); requests get preempted",
				c.name, f(a.kvCachePercent()))}},
		Object{"alert": "BasisModelServerSlowFirstToken", "for": "15m", "labels": labels,
			"expr": fmt.Sprintf(`histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket{%s}[10m]))) > %s`, sel, f(a.firstToken())),
			"annotations": Object{"summary": fmt.Sprintf("Model server %s: 95%% of requests wait up to {{ $value | humanizeDuration }} for the first token (threshold %ss)",
				c.name, f(a.firstToken()))}},
	}
	return Object{"apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule", "metadata": c.meta(c.name + "-server-alerts"),
		"spec": Object{"groups": []any{Object{"name": fmt.Sprintf("modelserver/%s/%s", c.ns, c.name), "rules": rules}}}}
}

// dashboard is the server's dashboard in the Project's Grafana (control
// plane): load, KV and prefix cache, latency and tokens, per replica and site.
func (c *composition) dashboard() Object {
	uid := "basis-ms-" + sha1hex(c.ns + "/" + c.name)[:12]
	return Object{
		"apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDashboard", "metadata": c.meta(c.name + "-server"),
		"spec": Object{
			"instanceSelector": Object{"matchLabels": Object{"dashboards.paas.cndev.nl/scope": c.ns}},
			"folder":           "Model servers",
			"uid":              uid,
			"resyncPeriod":     "10m",
			"json":             c.dashboardJSON(uid),
		},
	}
}

func (c *composition) dashboardJSON(uid string) string {
	ds := Object{"type": "prometheus", "uid": "${datasource}"}
	sel := fmt.Sprintf(`namespace=%q,server=%q,site=~"$site"`, c.ns, c.name)
	id := 0
	panel := func(title, unit string, x, y int, targets ...Object) Object {
		id++
		ts := make([]any, len(targets))
		for i, t := range targets {
			t["datasource"], t["refId"] = ds, string(rune('A'+i))
			ts[i] = t
		}
		return Object{"id": id, "type": "timeseries", "title": title, "datasource": ds,
			"gridPos": Object{"h": 8, "w": 12, "x": x, "y": y}, "targets": ts,
			"fieldConfig": Object{"defaults": Object{"unit": unit}, "overrides": []any{}}}
	}
	q := func(expr, legend string) Object { return Object{"expr": expr, "legendFormat": legend} }
	p := func(quantile, metric string) string {
		return fmt.Sprintf(`histogram_quantile(%s, sum by (le, site) (rate(%s_bucket{%s}[$__rate_interval])))`, quantile, metric, sel)
	}
	rate := func(metric string) string {
		return fmt.Sprintf(`sum by (site) (rate(%s{%s}[$__rate_interval]))`, metric, sel)
	}
	panels := []any{
		panel("Requests running and waiting", "short", 0, 0,
			q(fmt.Sprintf(`sum by (site) (vllm:num_requests_running{%s})`, sel), "running {{site}}"),
			q(fmt.Sprintf(`sum by (site) (vllm:num_requests_waiting{%s})`, sel), "waiting {{site}}")),
		panel("KV cache usage per replica", "percentunit", 12, 0,
			q(fmt.Sprintf(`vllm:kv_cache_usage_perc{%s}`, sel), "{{site}} {{pod}}")),
		// What prefix-cache-aware routing is for: requests landing where their prefix is cached.
		panel("Prefix cache hit rate", "percentunit", 0, 8,
			q(rate("vllm:prefix_cache_hits_total")+" / "+rate("vllm:prefix_cache_queries_total"), "{{site}}")),
		panel("Time to first token (p50, p95)", "s", 12, 8,
			q(p("0.5", "vllm:time_to_first_token_seconds"), "p50 {{site}}"),
			q(p("0.95", "vllm:time_to_first_token_seconds"), "p95 {{site}}")),
		panel("Inter-token latency (p50, p95)", "s", 0, 16,
			q(p("0.5", "vllm:inter_token_latency_seconds"), "p50 {{site}}"),
			q(p("0.95", "vllm:inter_token_latency_seconds"), "p95 {{site}}")),
		panel("Request duration (p50, p95)", "s", 12, 16,
			q(p("0.5", "vllm:e2e_request_latency_seconds"), "p50 {{site}}"),
			q(p("0.95", "vllm:e2e_request_latency_seconds"), "p95 {{site}}")),
		panel("Tokens per second", "short", 0, 24,
			q(rate("vllm:prompt_tokens_total"), "prompt {{site}}"),
			q(rate("vllm:generation_tokens_total"), "generated {{site}}")),
		panel("Finished requests and preemptions per second", "reqps", 12, 24,
			q(fmt.Sprintf(`sum by (site, finished_reason) (rate(vllm:request_success_total{%s}[$__rate_interval]))`, sel), "{{finished_reason}} {{site}}"),
			q(rate("vllm:num_preemptions_total"), "preempted {{site}}")),
	}
	d := Object{
		"uid": uid, "title": fmt.Sprintf("Model server: %s", c.name), "schemaVersion": 39, "refresh": "1m",
		"time": Object{"from": "now-6h", "to": "now"}, "tags": []any{"basis", "modelserver"},
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
