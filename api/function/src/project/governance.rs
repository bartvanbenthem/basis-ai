//! Governance and cost of a Project: what it is (classification, environment,
//! cost center), what it may spend (budget) and until when it lives
//! (expiresAt). Composed:
//!
//!     the namespaces (control plane and locations): labels
//!       platform.cndev.nl/classification, /environment, /cost-center and, once
//!       past spec.expiresAt, /expired=true. The admission policies read them:
//!       the models a gateway may use, exposure, nothing new in an expired project
//!     cost-rules       PrometheusRule basis-cost on the control plane: recording
//!                      rules pricing what runs in the project's locations (CPU and
//!                      memory requests of running pods, volume claims,
//!                      LoadBalancers, gateway tokens per model) with the
//!                      EnvironmentConfig basis-prices, per site; with
//!                      spec.budget, alerts on the month's forecast
//!     cost-dashboard   GrafanaDashboard basis-cost in the project's Grafana
//!
//! The control-plane Prometheus has every location's series (remote write),
//! so its rules see both sites. Without basis-prices, no cost rules.

use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::LazyLock;

use super::Settings;
use crate::common::kinds::crds::prometheus::prometheus_rule as pr;
use crate::common::kinds::{Labels, alert, scoped_dashboard, to_value};
use crate::common::gojson::{fmt_f, fmt_g_prec, marshal, quote, quote_meta};
use crate::common::util::{as_obj, as_str, or, past_day, sha1hex, trunc};

pub(super) const REQUIRED_PRICES: &str = "prices";

/// Turns monthly prices into hourly ones (365 * 24 / 12).
const HOURS_PER_MONTH: i64 = 730;

pub(super) struct Governance {
    classification: String,
    environment: String,
    cost_center: String,
    budget_monthly: f64,
    monthly_tokens: i64,
    pub expires_at: String,
    pub expired: bool,
    /// basis-prices data; None without the catalog.
    pub prices: Option<Map<String, Value>>,
}

/// A number from JSON or a string, 0 otherwise.
fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse::<f64>().ok().filter(|f| !f.is_nan()).unwrap_or(0.0),
        _ => 0.0,
    }
}

static LABEL_UNSAFE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]+").expect("valid"));

/// A cost center as a valid label value (the XRD keeps it close already).
fn label_value(s: &str) -> String {
    let s = LABEL_UNSAFE.replace_all(s, "-");
    let s = s.trim_matches(['-', '.', '_']);
    if s.len() > 63 {
        return s[..63].trim_end_matches(['-', '.', '_']).to_string();
    }
    s.to_string()
}

struct TokenPrice {
    model: String,
    /// Per 1M tokens.
    input: f64,
    output: f64,
}

impl Governance {
    pub(super) fn new(spec: &Map<String, Value>, required: &BTreeMap<String, Vec<Value>>) -> Governance {
        let budget = as_obj(spec.get("budget"));
        let expires_at = as_str(spec.get("expiresAt")).to_string();
        Governance {
            classification: or(as_str(spec.get("classification")), "internal").into(),
            environment: or(as_str(spec.get("environment")), "production").into(),
            cost_center: as_str(spec.get("costCenter")).into(),
            budget_monthly: num(budget.get("monthly")),
            monthly_tokens: num(budget.get("monthlyTokens")) as i64,
            // Expired at the end of that day, UTC.
            expired: past_day(&expires_at),
            expires_at,
            prices: required.get(REQUIRED_PRICES).and_then(|i| i.first()).map(|p| as_obj(p.get("data"))),
        }
    }

    /// The labels on the project's namespaces.
    pub(super) fn labels(&self) -> BTreeMap<String, String> {
        let mut l = BTreeMap::from([
            ("platform.cndev.nl/classification".to_string(), self.classification.clone()),
            ("platform.cndev.nl/environment".to_string(), self.environment.clone()),
        ]);
        let v = label_value(&self.cost_center);
        if !v.is_empty() {
            l.insert("platform.cndev.nl/cost-center".into(), v);
        }
        if self.expired {
            l.insert("platform.cndev.nl/expired".into(), "true".into());
        }
        l
    }

    pub(super) fn status(&self) -> Value {
        let mut st = json!({"classification": self.classification, "environment": self.environment, "expired": self.expired});
        if !self.cost_center.is_empty() {
            st["costCenter"] = json!(self.cost_center);
        }
        if !self.expires_at.is_empty() {
            st["expiresAt"] = json!(self.expires_at);
        }
        if self.budget_monthly > 0.0 || self.monthly_tokens > 0 {
            let mut b = json!({});
            if self.budget_monthly > 0.0 {
                b["monthly"] = json!(self.budget_monthly);
            }
            if self.monthly_tokens > 0 {
                b["monthlyTokens"] = json!(self.monthly_tokens);
            }
            st["budget"] = b;
        }
        if self.prices.is_some() {
            st["currency"] = json!(self.currency());
            st["costMetric"] = json!("basis:cost_per_hour");
        }
        st
    }

    fn currency(&self) -> String {
        or(self.prices.as_ref().map(|p| as_str(p.get("currency"))).unwrap_or(""), "EUR").to_string()
    }

    /// A monthly price from the catalog, per hour.
    fn hourly(&self, key: &str) -> f64 {
        num(self.prices.as_ref().and_then(|p| p.get(key))) / HOURS_PER_MONTH as f64
    }

    /// The catalog's per-model token prices, and its default.
    fn token_prices(&self) -> (Vec<TokenPrice>, TokenPrice) {
        let t = as_obj(self.prices.as_ref().and_then(|p| p.get("tokens")));
        let def = as_obj(t.get("default"));
        let d = TokenPrice { model: String::new(), input: num(def.get("input")), output: num(def.get("output")) };
        let mut out: Vec<TokenPrice> = t
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|m| as_obj(Some(m)))
            .filter(|m| !as_str(m.get("model")).is_empty())
            .map(|m| TokenPrice { model: as_str(m.get("model")).into(), input: num(m.get("input")), output: num(m.get("output")) })
            .collect();
        out.sort_by(|a, b| a.model.cmp(&b.model));
        (out, d)
    }

    /// PrometheusRule basis-cost: the project's cost per hour by site and
    /// component, its tokens per hour by model, and the budget alerts.
    pub(super) fn cost_rules(&self, s: &Settings) -> Value {
        let ns = &s.ns;
        let f = |v: f64| fmt_g_prec(v, 8);
        let sel = |extra: &str| format!("{{namespace={}{extra}}}", quote(ns));
        let running = format!("and on (namespace, pod, site) (kube_pod_status_phase{} == 1)", sel(",phase=\"Running\""));
        let record = |record: &str, expr: String, labels: Option<Labels>| pr::PrometheusRuleGroupsRules {
            record: Some(record.into()), expr: IntOrString::String(expr), labels, ..Default::default()
        };
        let cost = |component: &str, expr: String| {
            record("basis:cost_per_hour", expr, Some(Labels::from([("component".to_string(), component.to_string())])))
        };
        let mut rules = vec![
            cost("cpu", format!("sum by (namespace, site) (kube_pod_container_resource_requests{} {running}) * {}",
                sel(",resource=\"cpu\""), f(self.hourly("cpu")))),
            cost("memory", format!("sum by (namespace, site) (kube_pod_container_resource_requests{} {running}) / 1073741824 * {}",
                sel(",resource=\"memory\""), f(self.hourly("memory")))),
            cost("storage", format!("sum by (namespace, site) (kube_persistentvolumeclaim_resource_requests_storage_bytes{}) / 1073741824 * {}",
                sel(""), f(self.hourly("storage")))),
            cost("loadbalancer", format!("count by (namespace, site) (kube_service_spec_type{}) * {}",
                sel(",type=\"LoadBalancer\""), f(self.hourly("loadBalancer")))),
            record("basis:tokens_per_hour", format!(
                "sum by (namespace, site, gen_ai_request_model, gen_ai_token_type) (rate(gen_ai_client_token_usage_sum{}[5m])) * 3600", sel("")), None),
        ];
        let (models, def) = self.token_prices();
        let token_cost = |m: &str, p: &TokenPrice| {
            cost("tokens", format!(
                "sum by (namespace, site, gen_ai_request_model) (basis:tokens_per_hour{} * {} or basis:tokens_per_hour{} * {}) / 1e6",
                sel(&format!(",gen_ai_token_type=\"input\",{m}")), f(p.input), sel(&format!(",gen_ai_token_type=\"output\",{m}")), f(p.output)))
        };
        let mut priced = vec![];
        for m in &models {
            rules.push(token_cost(&format!("gen_ai_request_model={}", quote(&m.model)), m));
            priced.push(quote_meta(&m.model));
        }
        let other = if priced.is_empty() {
            "gen_ai_request_model!=\"\"".to_string()
        } else {
            format!("gen_ai_request_model!~{}", quote(&priced.join("|")))
        };
        rules.push(token_cost(&other, &def));
        // The month at the last day's run rate.
        rules.push(record("basis:cost_monthly_forecast", format!(
            "avg_over_time(sum by (namespace) (basis:cost_per_hour{})[1d:5m]) * {HOURS_PER_MONTH}", sel("")), None));
        rules.push(record("basis:tokens_monthly_forecast", format!(
            "avg_over_time(sum by (namespace) (basis:tokens_per_hour{})[1d:5m]) * {HOURS_PER_MONTH}", sel("")), None));

        let mut alerts = vec![];
        let mut alert = |name: &str, expr: String, severity: &str, summary: String| {
            let labels = Labels::from([("severity".to_string(), severity.to_string()), ("project".to_string(), s.name.clone())]);
            alerts.push(alert(name, "1h", expr, &labels, summary));
        };
        let currency = self.currency();
        if self.budget_monthly > 0.0 {
            let b = f(self.budget_monthly);
            alert("BasisBudgetForecastAbove80Percent", format!("basis:cost_monthly_forecast{} > 0.8 * {b}", sel("")), "warning",
                format!("Project {} is on track to spend {{{{ $value | printf \"%.0f\" }}}} {currency} this month, over 80% of its budget of {b}", s.name));
            alert("BasisBudgetForecastExceeded", format!("basis:cost_monthly_forecast{} > {b}", sel("")), "critical",
                format!("Project {} is on track to spend {{{{ $value | printf \"%.0f\" }}}} {currency} this month, over its budget of {b}", s.name));
        }
        if self.monthly_tokens > 0 {
            let t = self.monthly_tokens.to_string();
            alert("BasisTokenBudgetForecastAbove80Percent", format!("basis:tokens_monthly_forecast{} > 0.8 * {t}", sel("")), "warning",
                format!("Project {} is on track to use {{{{ $value | humanize }}}} tokens this month, over 80% of its {t}", s.name));
            alert("BasisTokenBudgetForecastExceeded", format!("basis:tokens_monthly_forecast{} > {t}", sel("")), "critical",
                format!("Project {} is on track to use {{{{ $value | humanize }}}} tokens this month, over its {t}", s.name));
        }
        let mut groups = vec![pr::PrometheusRuleGroups { name: "basis-cost".into(), interval: Some("1m".into()), rules: Some(rules), ..Default::default() }];
        if !alerts.is_empty() {
            groups.push(pr::PrometheusRuleGroups { name: "basis-budget".into(), rules: Some(alerts), ..Default::default() });
        }
        to_value(&pr::PrometheusRule { metadata: s.meta("basis-cost"), spec: pr::PrometheusRuleSpec { groups: Some(groups) }, status: None })
    }

    /// The project's cost in its Grafana.
    pub(super) fn cost_dashboard(&self, s: &Settings) -> Value {
        let uid = format!("basis-cost-{}", trunc(&sha1hex(&s.ns), 12));
        to_value(&scoped_dashboard(s.meta("basis-cost"), &s.ns, "Platform", uid.clone(), self.dashboard_json(s, &uid)))
    }

    fn dashboard_json(&self, s: &Settings, uid: &str) -> String {
        let ds = json!({"type": "prometheus", "uid": "${datasource}"});
        let sel = format!("{{namespace={}}}", quote(&s.ns));
        let target = |expr: &str, legend: &str| json!({"datasource": ds, "expr": expr, "legendFormat": legend, "refId": "A"});
        let stat = |id: i64, x: i64, title: &str, expr: &str, unit: &str| {
            json!({"id": id, "type": "stat", "title": title, "datasource": ds,
                "gridPos": {"h": 5, "w": 6, "x": x, "y": 0},
                "targets": [target(expr, "")],
                "fieldConfig": {"defaults": {"unit": unit, "decimals": 0}, "overrides": []},
                "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "value", "graphMode": "none"}})
        };
        let series = |id: i64, x: i64, y: i64, w: i64, title: &str, expr: &str, legend: &str, unit: &str| {
            json!({"id": id, "type": "timeseries", "title": title, "datasource": ds,
                "gridPos": {"h": 9, "w": w, "x": x, "y": y},
                "targets": [target(expr, legend)],
                "fieldConfig": {"defaults": {"unit": unit, "custom": {"stacking": {"mode": "normal"}, "fillOpacity": 20}}, "overrides": []}})
        };
        let money = format!("currency{}", self.currency());
        let budget = if self.budget_monthly > 0.0 { format!("vector({})", fmt_f(self.budget_monthly)) } else { "vector(0)".into() };
        let panels = vec![
            stat(1, 0, "Forecast this month", &format!("basis:cost_monthly_forecast{sel}"), &money),
            stat(2, 6, "Monthly budget", &budget, &money),
            stat(3, 12, "Cost per hour now", &format!("sum(basis:cost_per_hour{sel})"), &money),
            stat(4, 18, "Tokens this month (forecast)", &format!("basis:tokens_monthly_forecast{sel}"), "short"),
            series(5, 0, 5, 12, "Cost per hour by component", &format!("sum by (component) (basis:cost_per_hour{sel})"), "{{component}}", &money),
            series(6, 12, 5, 12, "Cost per hour by site", &format!("sum by (namespace, site) (basis:cost_per_hour{sel})"), "{{site}}", &money),
            series(7, 0, 14, 12, "Token cost per hour by model",
                &format!("sum by (gen_ai_request_model) (basis:cost_per_hour{{namespace=\"{}\",component=\"tokens\"}})", s.ns),
                "{{gen_ai_request_model}}", &money),
            series(8, 12, 14, 12, "Tokens per hour by model",
                &format!("sum by (gen_ai_request_model, gen_ai_token_type) (basis:tokens_per_hour{sel})"),
                "{{gen_ai_request_model}} {{gen_ai_token_type}}", "short"),
        ];
        let d = json!({
            "uid": uid, "title": format!("Cost: {}", s.name), "schemaVersion": 39, "refresh": "5m",
            "time": {"from": "now-7d", "to": "now"},
            "tags": ["basis", "cost"],
            "templating": {"list": [{"name": "datasource", "type": "datasource", "query": "prometheus", "current": {"text": "prometheus", "value": "prometheus"}}]},
            "panels": panels,
        });
        marshal(&d)
    }
}
