package mcpserver

// Monitoring of a server, from basis-mcp's own metrics (basis_mcp_*): tool
// calls per tool, client and outcome, their duration and hits, the
// embeddings model's calls, and whether the database is ready. Scraped in
// each site by the Project's Prometheus, alerted on there, and shown in a
// dashboard in the Project's Grafana.

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// podMonitor scrapes the server's pods, every series labelled with the
// server. Only basis_mcp_* is kept.
func (c *composition) podMonitor(selector map[string]string) Object {
	return Object{
		"apiVersion": "monitoring.coreos.com/v1", "kind": "PodMonitor", "metadata": c.meta(c.name + "-mcp"),
		"spec": Object{
			"selector": Object{"matchLabels": selector},
			"podMetricsEndpoints": []any{Object{
				"port": "metrics", "path": "/metrics", "interval": "30s",
				"relabelings": []any{Object{"targetLabel": "server", "replacement": c.name}},
				"metricRelabelings": []any{
					Object{"sourceLabels": []any{"__name__"}, "regex": "basis_mcp_.*", "action": "keep"},
				},
			}},
		},
	}
}

// alertRules are the server's alerts in a site with replicas: none of them
// up, the database not usable, tool calls failing or slow, and with
// embeddings the model failing.
func (c *composition) alertRules() Object {
	a := c.spec.Alerts
	sel := fmt.Sprintf(`namespace=%q,server=%q`, c.ns, c.name)
	f := func(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }
	labels := Object{"severity": "warning", "mcpserver": c.name}
	rules := []any{
		Object{"alert": "BasisMCPServerDown", "for": "10m", "labels": labels,
			"expr":        fmt.Sprintf(`(sum(up{%s}) or vector(0)) < 1`, sel),
			"annotations": Object{"summary": fmt.Sprintf("MCP server %s: no replica serves in this site", c.name)}},
		Object{"alert": "BasisMCPServerDatabaseNotReady", "for": "10m", "labels": labels,
			"expr": fmt.Sprintf(`max(basis_mcp_database_ready{%s}) < 1`, sel),
			"annotations": Object{"summary": fmt.Sprintf("MCP server %s can't use its database (the server's log says why: "+
				"unreachable, no vector extension, missing table or column, the embeddings model)", c.name)}},
		Object{"alert": "BasisMCPServerErrors", "for": "10m", "labels": labels,
			"expr": fmt.Sprintf(`100 * sum(rate(basis_mcp_tool_calls_total{%s,outcome="error"}[10m])) / sum(rate(basis_mcp_tool_calls_total{%s}[10m])) > %s`,
				sel, sel, f(a.errorRate())),
			"annotations": Object{"summary": fmt.Sprintf("MCP server %s: {{ $value | printf \"%%.1f\" }}%% of tool calls fail (threshold %s%%)",
				c.name, f(a.errorRate()))}},
		Object{"alert": "BasisMCPServerSlow", "for": "15m", "labels": labels,
			"expr": fmt.Sprintf(`histogram_quantile(0.95, sum by (le) (rate(basis_mcp_tool_duration_seconds_bucket{%s}[10m]))) > %s`, sel, f(a.latency())),
			"annotations": Object{"summary": fmt.Sprintf("MCP server %s: 95%% of tool calls take up to {{ $value | humanizeDuration }} (threshold %ss)",
				c.name, f(a.latency()))}},
	}
	if c.spec.embeds() {
		rules = append(rules, Object{"alert": "BasisMCPServerEmbeddingsFailing", "for": "10m", "labels": labels,
			"expr": fmt.Sprintf(`sum(rate(basis_mcp_embedding_requests_total{%s,outcome="error"}[10m])) / sum(rate(basis_mcp_embedding_requests_total{%s}[10m])) > 0.5`, sel, sel),
			"annotations": Object{"summary": fmt.Sprintf("MCP server %s: most calls to embeddings model %s fail; search falls back to full text, new rows wait for their embedding",
				c.name, c.spec.Embeddings.Model)}})
	}
	return Object{"apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule", "metadata": c.meta(c.name + "-mcp-alerts"),
		"spec": Object{"groups": []any{Object{"name": fmt.Sprintf("mcpserver/%s/%s", c.ns, c.name), "rules": rules}}}}
}

// dashboard is the server's dashboard in the Project's Grafana (control
// plane): calls, failures and latency per tool, calls per client, hits,
// the embeddings model, the database.
func (c *composition) dashboard() Object {
	uid := "basis-mcp-" + sha1hex(c.ns + "/" + c.name)[:12]
	return Object{
		"apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDashboard", "metadata": c.meta(c.name + "-mcp"),
		"spec": Object{
			"instanceSelector": Object{"matchLabels": Object{"dashboards.paas.cndev.nl/scope": c.ns}},
			"folder":           "MCP servers",
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
	p := func(quantile, metric, by string) string {
		return fmt.Sprintf(`histogram_quantile(%s, sum by (le, %s) (rate(%s_bucket{%s}[$__rate_interval])))`, quantile, by, metric, sel)
	}
	calls := func(by, extra string) string {
		return fmt.Sprintf(`sum by (%s) (rate(basis_mcp_tool_calls_total{%s%s}[$__rate_interval]))`, by, sel, extra)
	}
	panels := []any{
		panel("Tool calls per second", "reqps", 0, 0, q(calls("tool", ""), "{{tool}}")),
		panel("Failed tool calls per second", "reqps", 12, 0, q(calls("tool", `,outcome="error"`), "{{tool}}")),
		panel("Tool call duration (p50, p95)", "s", 0, 8,
			q(p("0.5", "basis_mcp_tool_duration_seconds", "tool"), "p50 {{tool}}"),
			q(p("0.95", "basis_mcp_tool_duration_seconds", "tool"), "p95 {{tool}}")),
		panel("Calls per client", "reqps", 12, 8, q(calls("client", ""), "{{client}}")),
		// Few hits for a search: the knowledge base lacks what agents look for.
		panel("Hits per search and recall (p50)", "short", 0, 16,
			q(p("0.5", "basis_mcp_tool_results", "tool"), "{{tool}}")),
		panel("Embeddings model: calls and p95 latency", "short", 12, 16,
			q(fmt.Sprintf(`sum by (outcome) (rate(basis_mcp_embedding_requests_total{%s}[$__rate_interval]))`, sel), "{{outcome}} /s"),
			q(fmt.Sprintf(`histogram_quantile(0.95, sum by (le) (rate(basis_mcp_embedding_duration_seconds_bucket{%s}[$__rate_interval])))`, sel), "p95 s")),
		panel("Database ready", "short", 0, 24,
			q(fmt.Sprintf(`min by (site) (basis_mcp_database_ready{%s})`, sel), "{{site}}")),
		panel("Backfilled embeddings and expired memories", "short", 12, 24,
			q(fmt.Sprintf(`sum(increase(basis_mcp_backfilled_embeddings_total{%s}[$__rate_interval]))`, sel), "backfilled"),
			q(fmt.Sprintf(`sum(increase(basis_mcp_expired_memories_total{%s}[$__rate_interval]))`, sel), "expired")),
	}
	d := Object{
		"uid": uid, "title": fmt.Sprintf("MCP server: %s", c.name), "schemaVersion": 39, "refresh": "1m",
		"time": Object{"from": "now-6h", "to": "now"}, "tags": []any{"basis", "mcpserver"},
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
