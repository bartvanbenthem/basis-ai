//! Composes a ModelServer (ai.cndev.nl/v1alpha1): a self-hosted model, vLLM on
//! KServe, with llm-d's inference scheduler for prefix-cache-aware routing, in
//! its Project's protected site and optionally its recovery site.
//!
//! In each site's location (provider-kubernetes Objects, prefix "<site>-"):
//!
//!     server           LLMInferenceService <name> (serving.kserve.io/v1alpha2):
//!                      vLLM serving spec.model.uri as the served name, the
//!                      site's replicas, GPUs (tensor parallel over more than
//!                      one); with spec.routing.prefixCacheAware (default) KServe
//!                      adds llm-d's endpoint picker and InferencePool
//!                      <name>-inference-pool, which a ModelGateway routes to
//!     token,           with spec.model.tokenSecretRef: Secret <name>-model-token
//!     serviceaccount   (HF_TOKEN patched from the Project's Secret, never in the
//!                      Object spec) and ServiceAccount <name>-model listing it,
//!                      from which KServe hands the token to the model download
//!     podmonitor       vLLM's metrics (requests, queue, KV and prefix cache,
//!                      latency, tokens), labelled with server
//!     prometheusrule   with replicas in the site: no ready replica, requests
//!                      waiting, KV cache full, slow first token (spec.alerts)
//!
//! On the control plane: dashboard, a GrafanaDashboard in the Project's
//! Grafana (vLLM's own metrics, vllm:*, per replica and site).
//!
//! KServe names what it creates after the LLMInferenceService: the Service
//! <name>-kserve-workload-svc:8000 (plain HTTP, the platform leaves KServe's
//! TLS between gateway and server off) and the InferencePool. Locations are
//! pinned in status.sites, so a server never moves.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::common::gojson::{fmt_g, marshal, quote};
use crate::common::lenient::decode;
use crate::common::util::{as_str, condition, condition_true, dig_opt, labels_obj, live, or, or_f, or_i, reported, sha1hex};
use crate::common::{Composed, Condition, Input, Output, Requirement, Result};
use crate::lenient;

/// The Project the server's sites come from.
pub const REQUIRED_PROJECT: &str = "project";
/// vLLM's port, behind KServe's workload Service.
pub const PORT: i64 = 8000;

pub const SITE_PROTECTED: &str = "protected";
pub const SITE_RECOVERY: &str = "recovery";

lenient! {
    pub struct Metadata { pub name: String, pub namespace: String, pub labels: BTreeMap<String, String> }
}
lenient! {
    pub struct SiteRef { pub site: String, pub location: String }
}
lenient! {
    pub struct XrStatus { pub sites: Vec<SiteRef> }
}
lenient! {
    /// The ModelServer XR, as far as the composition reads it. Fields mirror
    /// apis/modelserver/definition.yaml; the accessors repeat the XRD
    /// defaults so `crossplane render` and older objects come out the same.
    pub struct Xr { pub metadata: Metadata, pub spec: Spec, pub status: XrStatus }
}
lenient! {
    pub struct SecretKey { pub name: String, pub key: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Model { pub uri: String, pub name: String, pub token_secret_ref: Option<SecretKey> }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Resources { pub cpu: String, pub memory: String, pub gpus: Option<i64>, pub gpu_resource: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Routing { pub prefix_cache_aware: Option<bool> }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Scheduling { pub node_selector: BTreeMap<String, String>, pub tolerations: Vec<Value> }
}
lenient! {
    pub struct Recovery { pub enabled: bool, pub replicas: Option<i64> }
}
lenient! {
    /// The thresholds of the server's alerts.
    #[serde(rename_all = "camelCase")]
    pub struct Alerts {
        pub waiting_requests: i64,
        #[serde(rename = "kvCacheUsagePercent")]
        pub kv_cache_usage_percent: f64,
        pub time_to_first_token_seconds: f64,
        pub disabled: bool,
    }
}
lenient! {
    pub struct Spec {
        pub model: Model,
        pub replicas: Option<i64>,
        pub resources: Resources,
        pub image: String,
        pub args: Vec<String>,
        pub routing: Routing,
        pub scheduling: Scheduling,
        pub recovery: Recovery,
        pub alerts: Alerts,
    }
}

impl Spec {
    fn replicas(&self) -> i64 {
        self.replicas.unwrap_or(1)
    }
    fn standby_replicas(&self) -> i64 {
        self.recovery.replicas.unwrap_or(1)
    }
    /// The vLLM replicas in site.
    fn site_replicas(&self, site: &str) -> i64 {
        if site == SITE_RECOVERY { self.standby_replicas() } else { self.replicas() }
    }
    fn prefix_cache_aware(&self) -> bool {
        self.routing.prefix_cache_aware.unwrap_or(true)
    }
}

impl Resources {
    fn cpu(&self) -> &str {
        or(&self.cpu, "4")
    }
    fn memory(&self) -> &str {
        or(&self.memory, "16Gi")
    }
    fn gpus(&self) -> i64 {
        self.gpus.unwrap_or(1)
    }
    fn gpu_resource(&self) -> &str {
        or(&self.gpu_resource, "nvidia.com/gpu")
    }
}

impl Alerts {
    fn waiting(&self) -> i64 {
        or_i(self.waiting_requests, 10)
    }
    fn kv_cache_percent(&self) -> f64 {
        or_f(self.kv_cache_usage_percent, 95.0)
    }
    fn first_token(&self) -> f64 {
        or_f(self.time_to_first_token_seconds, 10.0)
    }
}

/// The Project (its sites).
pub fn requirements(input: &Input) -> BTreeMap<String, Requirement> {
    let ns = as_str(input.xr.pointer("/metadata/namespace"));
    BTreeMap::from([(REQUIRED_PROJECT.into(), Requirement::named("platform.cndev.nl/v1alpha1", "Project", "", ns))])
}

/// The pool KServe creates for server name: what a gateway routes to with
/// prefix-cache-aware routing.
pub fn inference_pool(name: &str) -> String {
    format!("{name}-inference-pool")
}

/// KServe's Service in front of server name's replicas.
pub fn service(name: &str) -> String {
    format!("{name}-kserve-workload-svc")
}

/// The OpenAI base URL of server name in namespace, in each of its sites.
pub fn endpoint(name: &str, namespace: &str) -> String {
    format!("http://{}.{namespace}.svc:{PORT}/v1", service(name))
}

/// The model name the server answers to: spec.model.name, else its name.
pub fn served_name(xr: &Value) -> String {
    let x: Xr = decode(xr);
    or(&x.spec.model.name, &x.metadata.name).to_string()
}

struct Composition<'a> {
    spec: &'a Spec,
    name: &'a str,
    ns: &'a str,
    observed: &'a BTreeMap<String, Value>,
    labels: Map<String, Value>,
}

/// A manifest for a location, with how to tell it's ready.
struct Obj {
    manifest: Value,
    /// A Secret whose data comes from the control plane: (Secret, field, to field).
    copy_from: Option<(String, String, String)>,
    ready: crate::common::ReadyFn,
}

fn always(_: Option<&Value>) -> bool {
    true
}

fn object_ready(o: Option<&Value>) -> bool {
    condition_true(o, "Ready")
}

/// Renders the desired state of a ModelServer.
pub fn compose(input: &Input) -> Result<Output> {
    let xr: Xr = decode(&input.xr);
    let labels = labels_obj(&[
        ("app.kubernetes.io/managed-by", "crossplane"),
        ("app.kubernetes.io/part-of", "basis"),
        ("ai.cndev.nl/modelserver", &xr.metadata.name),
    ]);
    let c = Composition { spec: &xr.spec, name: &xr.metadata.name, ns: &xr.metadata.namespace, observed: &input.observed, labels };
    let spec = c.spec;
    let mut out = Output::default();

    // ---- sites: pinned in status.sites, else the Project's locations
    let project = input.first(REQUIRED_PROJECT);
    let pinned: BTreeMap<&str, &str> = xr.status.sites.iter().map(|s| (s.site.as_str(), s.location.as_str())).collect();
    let location = |s: &str| -> String {
        or(pinned.get(s).copied().unwrap_or(""), as_str(dig_opt(project, &["spec", "locations", s]))).to_string()
    };
    let mut sites = vec![SITE_PROTECTED];
    if spec.recovery.enabled {
        sites.push(SITE_RECOVERY);
    }

    let dashboard = c.dashboard();
    let dashboard_uid = dashboard["spec"]["uid"].clone();
    out.composed.insert("dashboard".into(), Composed { ready: true, object: dashboard });
    let mut status = json!({"ready": false, "message": "", "model": or(&spec.model.name, c.name),
        "endpoint": endpoint(c.name, c.ns), "dashboardUid": dashboard_uid, "sites": []});
    if spec.prefix_cache_aware() {
        status["inferencePool"] = json!(inference_pool(c.name));
    }

    let mut problems: Vec<String> = vec![];
    let mut waiting: Vec<String> = vec![];
    let (mut all_ready, mut serving) = (true, false);
    let mut site_status = vec![];
    for s in &sites {
        let replicas = spec.site_replicas(s);
        let loc = location(s);
        let mut ss = json!({"site": s, "location": loc, "replicas": replicas, "ready": false});
        if loc.is_empty() {
            site_status.push(ss);
            problems.push(format!("Project {} has no {s} location (spec.locations.{s})", c.ns));
            all_ready = false;
            continue;
        }
        for (key, o) in c.site_objects(replicas) {
            let k = format!("{s}-{key}");
            let mut w = c.wrap(&k, &loc, o.manifest, o.copy_from.as_ref());
            w.ready = (o.ready)(c.observed.get(&k));
            out.composed.insert(k, w);
        }
        let server = c.observed.get(&format!("{s}-server"));
        let mut ready = out.composed[&format!("{s}-server")].ready;
        if let Some(synced) = condition(server, "Synced").filter(|c| c.get("status").and_then(Value::as_str) == Some("False")) {
            let msg = format!(
                "can't apply the LLMInferenceService in {loc} (is KServe installed there?): {}",
                as_str(synced.get("message"))
            );
            ss["message"] = json!(msg);
            problems.push(msg);
        } else if !ready {
            let msg = or(&not_ready(live(server)), &format!("waiting for KServe in {loc}")).to_string();
            waiting.push(format!("{s} ({loc}): {msg}"));
            ss["message"] = json!(msg);
        }
        if let Some(t) = out.composed.get(&format!("{s}-token"))
            && !t.ready {
                ready = false;
                let from = spec.model.token_secret_ref.as_ref().map(|r| r.name.as_str()).unwrap_or("");
                waiting.push(format!("{s}: copying the token Secret {from} to {loc}"));
            }
        ss["ready"] = json!(ready);
        all_ready = all_ready && ready;
        serving = serving || (ready && replicas > 0);
        site_status.push(ss);
    }
    status["sites"] = json!(site_status);

    status["ready"] = json!(all_ready);
    let mut cond = Condition { status: all_ready, reason: "Available".into(), message: String::new() };
    let msg = if !problems.is_empty() {
        cond.reason = "Waiting".into();
        problems.join("; ")
    } else if !all_ready {
        cond.reason = "Creating".into();
        format!("Waiting for vLLM: {}", waiting.join("; "))
    } else if !serving {
        format!("Server {} is stopped (no replicas)", c.name)
    } else {
        format!("Server {} serves {}", c.name, status["model"].as_str().unwrap_or(""))
    };
    status["message"] = json!(msg);
    cond.message = msg;
    out.status = status;
    out.condition = cond;
    Ok(out)
}

/// The message of the first condition (by message) KServe reports as not true.
fn not_ready(o: Option<&Value>) -> String {
    let mut msgs: Vec<String> = dig_opt(o, &["status", "conditions"])
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|m| m.get("status").and_then(Value::as_str) != Some("True") && m.get("type").and_then(Value::as_str) != Some("Ready"))
        .filter_map(|m| {
            let msg = as_str(m.get("message"));
            (!msg.is_empty()).then(|| format!("{}: {msg}", crate::common::gojson::sprint(m.get("type").unwrap_or(&Value::Null))))
        })
        .collect();
    msgs.sort();
    msgs.into_iter().next().unwrap_or_default()
}

impl Composition<'_> {
    fn token_secret(&self) -> String {
        format!("{}-model-token", self.name)
    }
    fn service_account(&self) -> String {
        format!("{}-model", self.name)
    }

    /// What runs in a site's location, by composition resource name (without
    /// the site prefix).
    fn site_objects(&self, replicas: i64) -> BTreeMap<&'static str, Obj> {
        let spec = self.spec;
        let mut out = BTreeMap::new();
        let res = &spec.resources;
        let mut requests = json!({"cpu": res.cpu(), "memory": res.memory()});
        let mut limits = json!({"memory": res.memory()});
        if res.gpus() > 0 {
            requests[res.gpu_resource()] = json!(res.gpus());
            limits[res.gpu_resource()] = json!(res.gpus());
        }
        let mut main = json!({"name": "main", "resources": {"requests": requests, "limits": limits}});
        if !spec.image.is_empty() {
            main["image"] = json!(spec.image);
        }
        if res.gpus() == 0 {
            // vLLM's CPU image runs as root; KServe's own CPU sample allows it
            // the same way. Privilege escalation and capabilities stay off.
            main["securityContext"] = json!({"runAsNonRoot": false});
        }
        if !spec.args.is_empty() {
            // After KServe's own flags (its command ends in "$@").
            main["args"] = json!(spec.args);
        }
        let mut template = json!({"containers": [main]});
        if !spec.scheduling.node_selector.is_empty() {
            template["nodeSelector"] = json!(spec.scheduling.node_selector);
        }
        if !spec.scheduling.tolerations.is_empty() {
            template["tolerations"] = json!(spec.scheduling.tolerations);
        }
        if let Some(r) = &spec.model.token_secret_ref {
            // KServe gives the model download the HF_TOKEN of the Secrets its
            // ServiceAccount lists.
            template["serviceAccountName"] = json!(self.service_account());
            out.insert("token", Obj {
                ready: Box::new(object_ready),
                copy_from: Some((r.name.clone(), format!("data.{}", or(&r.key, "HF_TOKEN")), "data.HF_TOKEN".into())),
                manifest: json!({"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": self.meta(&self.token_secret())}),
            });
            out.insert("serviceaccount", Obj { ready: Box::new(reported), copy_from: None, manifest: json!({
                "apiVersion": "v1", "kind": "ServiceAccount", "metadata": self.meta(&self.service_account()),
                "secrets": [{"name": self.token_secret()}],
            })});
        }
        let mut server = json!({
            "model": {"uri": spec.model.uri, "name": or(&spec.model.name, self.name)},
            "replicas": replicas,
            "template": template,
            // Onto everything KServe creates, next to its own labels. Not the
            // app.kubernetes.io ones: KServe's part-of label is how it finds its
            // Deployments, and how the InferencePool and PodMonitor select pods.
            "labels": {"ai.cndev.nl/modelserver": self.name},
        });
        if res.gpus() > 1 {
            server["parallelism"] = json!({"tensor": res.gpus()});
        }
        if spec.prefix_cache_aware() {
            // llm-d's endpoint picker with KServe's default configuration:
            // approximate prefix-cache affinity, then the replicas' token load.
            server["router"] = json!({"scheduler": {}});
        }
        out.insert("server", Obj {
            // A stopped site has nothing to wait for.
            ready: Box::new(move |o| condition_true(live(o), "Ready") || (replicas == 0 && reported(o))),
            copy_from: None,
            manifest: json!({"apiVersion": "serving.kserve.io/v1alpha2", "kind": "LLMInferenceService",
                "metadata": self.meta(self.name), "spec": server}),
        });
        out.insert("podmonitor", Obj { ready: Box::new(always), copy_from: None, manifest: self.pod_monitor() });
        if !spec.alerts.disabled && replicas > 0 {
            out.insert("prometheusrule", Obj { ready: Box::new(always), copy_from: None, manifest: self.alert_rules() });
        }
        out
    }

    /// Puts a location object into a provider-kubernetes Object.
    fn wrap(&self, key: &str, location: &str, manifest: Value, copy_from: Option<&(String, String, String)>) -> Composed {
        let mut spec = json!({
            "providerConfigRef": {"kind": "ClusterProviderConfig", "name": location},
            "watch": true,
            "forProvider": {"manifest": manifest},
        });
        if let Some((from, field, to)) = copy_from {
            // The Secret's data comes from the control plane, never through this spec.
            spec["references"] = json!([{"patchesFrom": {"apiVersion": "v1", "kind": "Secret",
                "name": from, "namespace": self.ns, "fieldPath": field}, "toFieldPath": to}]);
        }
        Composed { ready: false, object: json!({
            "apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
            "metadata": {"name": format!("{}-{key}", self.name), "namespace": self.ns, "labels": self.labels,
                "annotations": {"platform.cndev.nl/location": location}},
            "spec": spec,
        })}
    }

    fn meta(&self, name: &str) -> Value {
        json!({"name": name, "namespace": self.ns, "labels": self.labels})
    }

    // ---- monitoring, from vLLM's own metrics (vllm:*)

    /// Scrapes vLLM in the server's pods (KServe's workload labels; the
    /// scheduler's pods have another component), every series labelled with
    /// the server. Only vllm:* is kept.
    fn pod_monitor(&self) -> Value {
        json!({
            "apiVersion": "monitoring.coreos.com/v1", "kind": "PodMonitor", "metadata": self.meta(&format!("{}-vllm", self.name)),
            "spec": {
                "selector": {"matchLabels": {
                    "app.kubernetes.io/name": self.name,
                    "app.kubernetes.io/part-of": "llminferenceservice",
                    "kserve.io/component": "workload",
                }},
                "podMetricsEndpoints": [{
                    // vLLM's API port (KServe's container has no named port).
                    "targetPort": PORT, "path": "/metrics", "interval": "30s",
                    "relabelings": [{"targetLabel": "server", "replacement": self.name}],
                    "metricRelabelings": [{"sourceLabels": ["__name__"], "regex": "vllm:.*", "action": "keep"}],
                }],
            },
        })
    }

    /// The server's alerts in a site with replicas: none of them up, requests
    /// queueing, the KV cache full (requests get preempted), the first token slow.
    fn alert_rules(&self) -> Value {
        let a = &self.spec.alerts;
        let name = self.name;
        let sel = format!("namespace={},server={}", quote(self.ns), quote(name));
        let labels = json!({"severity": "warning", "server": name});
        let rules = json!([
            // Loading a large model takes a while: 15 minutes before it counts.
            {"alert": "BasisModelServerDown", "for": "15m", "labels": labels,
             "expr": format!("(sum(up{{{sel}}}) or vector(0)) < 1"),
             "annotations": {"summary": format!("Model server {name}: no replica serves in this site")}},
            {"alert": "BasisModelServerQueueing", "for": "10m", "labels": labels,
             "expr": format!("sum(vllm:num_requests_waiting{{{sel}}}) > {}", a.waiting()),
             "annotations": {"summary": format!("Model server {name}: {{{{ $value }}}} requests wait for a slot (threshold {}); add replicas", a.waiting())}},
            {"alert": "BasisModelServerKVCacheFull", "for": "15m", "labels": labels,
             "expr": format!("100 * max(vllm:kv_cache_usage_perc{{{sel}}}) > {}", fmt_g(a.kv_cache_percent())),
             "annotations": {"summary": format!(
                 "Model server {name}: a replica's KV cache is {{{{ $value | printf \"%.0f\" }}}}% full (threshold {}%); requests get preempted",
                 fmt_g(a.kv_cache_percent()))}},
            {"alert": "BasisModelServerSlowFirstToken", "for": "15m", "labels": labels,
             "expr": format!("histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket{{{sel}}}[10m]))) > {}", fmt_g(a.first_token())),
             "annotations": {"summary": format!(
                 "Model server {name}: 95% of requests wait up to {{{{ $value | humanizeDuration }}}} for the first token (threshold {}s)",
                 fmt_g(a.first_token()))}},
        ]);
        json!({"apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule", "metadata": self.meta(&format!("{name}-server-alerts")),
            "spec": {"groups": [{"name": format!("modelserver/{}/{name}", self.ns), "rules": rules}]}})
    }

    /// The server's dashboard in the Project's Grafana (control plane): load,
    /// KV and prefix cache, latency and tokens, per replica and site.
    fn dashboard(&self) -> Value {
        let uid = format!("basis-ms-{}", &sha1hex(&format!("{}/{}", self.ns, self.name))[..12]);
        json!({
            "apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDashboard", "metadata": self.meta(&format!("{}-server", self.name)),
            "spec": {
                "instanceSelector": {"matchLabels": {"dashboards.paas.cndev.nl/scope": self.ns}},
                "folder": "Model servers",
                "uid": uid,
                "resyncPeriod": "10m",
                "json": self.dashboard_json(&uid),
            },
        })
    }

    fn dashboard_json(&self, uid: &str) -> String {
        let ds = json!({"type": "prometheus", "uid": "${datasource}"});
        let sel = format!("namespace={},server={},site=~\"$site\"", quote(self.ns), quote(self.name));
        let mut id = 0;
        let mut panel = |title: &str, unit: &str, x: i64, y: i64, targets: Vec<Value>| {
            id += 1;
            let ts: Vec<Value> = targets
                .into_iter()
                .enumerate()
                .map(|(i, mut t)| {
                    t["datasource"] = ds.clone();
                    t["refId"] = json!(((b'A' + i as u8) as char).to_string());
                    t
                })
                .collect();
            json!({"id": id, "type": "timeseries", "title": title, "datasource": ds,
                "gridPos": {"h": 8, "w": 12, "x": x, "y": y}, "targets": ts,
                "fieldConfig": {"defaults": {"unit": unit}, "overrides": []}})
        };
        let q = |expr: String, legend: &str| json!({"expr": expr, "legendFormat": legend});
        let p = |quantile: &str, metric: &str| {
            format!("histogram_quantile({quantile}, sum by (le, site) (rate({metric}_bucket{{{sel}}}[$__rate_interval])))")
        };
        let rate = |metric: &str| format!("sum by (site) (rate({metric}{{{sel}}}[$__rate_interval]))");
        let panels = vec![
            panel("Requests running and waiting", "short", 0, 0, vec![
                q(format!("sum by (site) (vllm:num_requests_running{{{sel}}})"), "running {{site}}"),
                q(format!("sum by (site) (vllm:num_requests_waiting{{{sel}}})"), "waiting {{site}}"),
            ]),
            panel("KV cache usage per replica", "percentunit", 12, 0, vec![
                q(format!("vllm:kv_cache_usage_perc{{{sel}}}"), "{{site}} {{pod}}"),
            ]),
            // What prefix-cache-aware routing is for: requests landing where their prefix is cached.
            panel("Prefix cache hit rate", "percentunit", 0, 8, vec![
                q(format!("{} / {}", rate("vllm:prefix_cache_hits_total"), rate("vllm:prefix_cache_queries_total")), "{{site}}"),
            ]),
            panel("Time to first token (p50, p95)", "s", 12, 8, vec![
                q(p("0.5", "vllm:time_to_first_token_seconds"), "p50 {{site}}"),
                q(p("0.95", "vllm:time_to_first_token_seconds"), "p95 {{site}}"),
            ]),
            panel("Inter-token latency (p50, p95)", "s", 0, 16, vec![
                q(p("0.5", "vllm:inter_token_latency_seconds"), "p50 {{site}}"),
                q(p("0.95", "vllm:inter_token_latency_seconds"), "p95 {{site}}"),
            ]),
            panel("Request duration (p50, p95)", "s", 12, 16, vec![
                q(p("0.5", "vllm:e2e_request_latency_seconds"), "p50 {{site}}"),
                q(p("0.95", "vllm:e2e_request_latency_seconds"), "p95 {{site}}"),
            ]),
            panel("Tokens per second", "short", 0, 24, vec![
                q(rate("vllm:prompt_tokens_total"), "prompt {{site}}"),
                q(rate("vllm:generation_tokens_total"), "generated {{site}}"),
            ]),
            panel("Finished requests and preemptions per second", "reqps", 12, 24, vec![
                q(format!("sum by (site, finished_reason) (rate(vllm:request_success_total{{{sel}}}[$__rate_interval]))"), "{{finished_reason}} {{site}}"),
                q(rate("vllm:num_preemptions_total"), "preempted {{site}}"),
            ]),
        ];
        let d = json!({
            "uid": uid, "title": format!("Model server: {}", self.name), "schemaVersion": 39, "refresh": "1m",
            "time": {"from": "now-6h", "to": "now"}, "tags": ["basis", "modelserver"],
            "templating": {"list": [
                {"name": "datasource", "type": "datasource", "query": "prometheus", "current": {"text": "prometheus", "value": "prometheus"}},
                {"name": "site", "type": "custom", "query": "protected,recovery", "includeAll": true, "multi": true,
                 "current": {"text": "All", "value": "$__all"}, "allValue": ".*"},
            ]},
            "panels": panels,
        });
        marshal(&d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODEL: &str = r#""model":{"uri":"hf://meta-llama/Llama-3.1-8B-Instruct"}"#;

    fn xr(spec: &str, status: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"ModelServer","metadata":{{"name":"llama","namespace":"ai"}},"spec":{spec},"status":{status}}}"#
        )).unwrap()
    }

    fn input(xr: Value, recovery: bool, observed: &[(&str, Value)]) -> Input {
        let mut locations = json!({"protected": "dc-a"});
        if recovery {
            locations["recovery"] = json!("dc-b");
        }
        Input {
            xr,
            observed: observed.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            required: BTreeMap::from([(REQUIRED_PROJECT.to_string(), vec![json!({"spec": {"locations": locations}})])]),
        }
    }

    fn manifest(c: &Composed) -> &Value {
        &c.object["spec"]["forProvider"]["manifest"]
    }

    /// An Object whose LLMInferenceService the location reports with ready.
    fn observed_server(ready: &str, extra: Option<Value>) -> Value {
        let mut conds = vec![json!({"type": "Ready", "status": ready})];
        conds.extend(extra);
        json!({"status": {"atProvider": {"manifest": {"kind": "LLMInferenceService", "status": {"conditions": conds}}}}})
    }

    #[test]
    fn vllm_with_llm_ds_scheduler_in_the_protected_location() {
        let out = compose(&input(xr(&format!("{{{MODEL}}}"), "{}"), true, &[])).unwrap();
        assert!(!out.composed.contains_key("recovery-server"), "recovery site without recovery.enabled");
        let srv = manifest(&out.composed["protected-server"]);
        assert_eq!(srv["kind"], "LLMInferenceService");
        assert_eq!(out.composed["protected-server"].object["spec"]["providerConfigRef"]["name"], "dc-a");
        let spec = &srv["spec"];
        assert_eq!(spec["model"], json!({"name": "llama", "uri": "hf://meta-llama/Llama-3.1-8B-Instruct"}), "served as the ModelServer's name");
        assert_eq!(spec["replicas"], 1);
        assert!(spec.get("parallelism").is_none());
        assert_eq!(spec["labels"], json!({"ai.cndev.nl/modelserver": "llama"}), "none of KServe's own (app.kubernetes.io/part-of finds its Deployments)");
        assert!(spec["router"]["scheduler"].is_object(), "prefix-cache-aware routing needs the scheduler");
        let main = &spec["template"]["containers"][0];
        let res = &main["resources"];
        assert_eq!(res["requests"]["nvidia.com/gpu"], 1);
        assert_eq!(res["limits"]["nvidia.com/gpu"], 1);
        assert_eq!(res["limits"]["memory"], "16Gi");
        assert!(main.get("image").is_none() && main.get("securityContext").is_none() && main.get("args").is_none(), "KServe's image and flags by default");
        assert_eq!(out.status["endpoint"], "http://llama-kserve-workload-svc.ai.svc:8000/v1");
        assert_eq!(out.status["inferencePool"], "llama-inference-pool");
        assert_eq!(out.status["model"], "llama");
        assert_eq!(out.status["ready"], false);
        assert_eq!(out.condition.reason, "Creating");
        assert!(out.status["message"].as_str().unwrap().contains("waiting for KServe in dc-a"));
        assert_eq!(out.composed["dashboard"].object["kind"], "GrafanaDashboard");
        assert!(!out.status["dashboardUid"].as_str().unwrap().is_empty());
    }

    #[test]
    fn served_name_gpus_image_flags_and_scheduling() {
        let out = compose(&input(xr(r#"{"model":{"uri":"pvc://models/llama","name":"meta-llama/Llama-3.1-70B"},"replicas":3,
            "resources":{"gpus":4,"gpuResource":"amd.com/gpu","memory":"200Gi"},"image":"rocm/vllm:latest",
            "args":["--max-model-len=8192"],"routing":{"prefixCacheAware":false},
            "scheduling":{"nodeSelector":{"gpu":"mi300"},"tolerations":[{"key":"gpu","operator":"Exists","effect":"NoSchedule"}]}}"#, "{}"), false, &[])).unwrap();
        let spec = &manifest(&out.composed["protected-server"])["spec"];
        assert_eq!(spec["model"]["name"], "meta-llama/Llama-3.1-70B");
        assert_eq!(spec["replicas"], 3);
        assert_eq!(spec["parallelism"]["tensor"], 4);
        assert!(spec.get("router").is_none() && out.status.get("inferencePool").is_none(), "no scheduler without prefixCacheAware");
        let tpl = &spec["template"];
        let main = &tpl["containers"][0];
        assert_eq!(main["image"], "rocm/vllm:latest");
        assert_eq!(main["args"].as_array().unwrap().len(), 1);
        assert_eq!(main["resources"]["limits"]["amd.com/gpu"], 4);
        assert_eq!(tpl["nodeSelector"]["gpu"], "mi300");
        assert_eq!(tpl["tolerations"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn cpu_only() {
        let out = compose(&input(xr(&format!(r#"{{{MODEL},"resources":{{"gpus":0}},"image":"vllm/vllm-openai-cpu:v0.23.0"}}"#), "{}"), false, &[])).unwrap();
        let main = &manifest(&out.composed["protected-server"])["spec"]["template"]["containers"][0];
        for k in ["requests", "limits"] {
            for r in main["resources"][k].as_object().unwrap().keys() {
                assert!(!r.contains("gpu"), "{k} {r} without GPUs");
            }
        }
        assert_eq!(main["securityContext"]["runAsNonRoot"], false, "the CPU image runs as root");
    }

    #[test]
    fn a_hugging_face_token_through_a_service_account() {
        let out = compose(&input(xr(r#"{"model":{"uri":"hf://meta-llama/Llama-3.1-8B-Instruct","tokenSecretRef":{"name":"hf"}}}"#, "{}"), false, &[])).unwrap();
        let r = &out.composed["protected-token"].object["spec"]["references"][0];
        assert_eq!(r["patchesFrom"]["name"], "hf");
        assert_eq!(r["patchesFrom"]["fieldPath"], "data.HF_TOKEN");
        assert_eq!(r["toFieldPath"], "data.HF_TOKEN");
        let m = manifest(&out.composed["protected-token"]);
        assert!(m.get("data").is_none() && m.get("stringData").is_none(), "token data in the Object spec");
        let sa = manifest(&out.composed["protected-serviceaccount"]);
        assert_eq!(sa["kind"], "ServiceAccount");
        assert_eq!(sa["metadata"]["name"], "llama-model");
        assert_eq!(sa["secrets"][0]["name"], "llama-model-token");
        assert_eq!(manifest(&out.composed["protected-server"])["spec"]["template"]["serviceAccountName"], "llama-model");
    }

    #[test]
    fn both_sites_ready_a_stopped_standby() {
        let observed = [("protected-server", observed_server("True", None)), ("recovery-server", observed_server("False", None))];
        let out = compose(&input(xr(&format!(r#"{{{MODEL},"replicas":2,"recovery":{{"enabled":true,"replicas":0}}}}"#),
            r#"{"sites":[{"site":"protected","location":"pinned"}]}"#), true, &observed)).unwrap();
        assert_eq!(out.composed["protected-server"].object["spec"]["providerConfigRef"]["name"], "pinned", "pinned, else the Project's");
        assert_eq!(out.composed["recovery-server"].object["spec"]["providerConfigRef"]["name"], "dc-b");
        assert_eq!(manifest(&out.composed["recovery-server"])["spec"]["replicas"], 0);
        assert!(!out.composed.contains_key("recovery-prometheusrule"), "no alerts for a stopped site");
        assert_eq!(out.status["ready"], true);
        assert!(out.condition.status);
        assert_eq!(out.status["sites"][1]["ready"], true);
    }

    #[test]
    fn not_ready_kserves_reason_not_applied_kserve_missing() {
        let observed = [("protected-server", observed_server("False",
            Some(json!({"type": "MainWorkloadReady", "status": "False", "message": "0/1 nodes have nvidia.com/gpu"}))))];
        let out = compose(&input(xr(&format!("{{{MODEL}}}"), "{}"), false, &observed)).unwrap();
        assert_eq!(out.status["ready"], false);
        assert!(out.status["message"].as_str().unwrap().contains("MainWorkloadReady: 0/1 nodes have nvidia.com/gpu"));
        let observed = [("protected-server", json!({"status": {"conditions": [{"type": "Synced", "status": "False", "message": "no matches for kind"}]}}))];
        let out = compose(&input(xr(&format!("{{{MODEL}}}"), "{}"), false, &observed)).unwrap();
        assert_eq!(out.condition.reason, "Waiting");
        assert!(out.status["message"].as_str().unwrap().contains("is KServe installed there?"));
    }

    #[test]
    fn no_project_location() {
        let out = compose(&Input { xr: xr(&format!("{{{MODEL}}}"), "{}"), ..Default::default() }).unwrap();
        assert!(!out.composed.contains_key("protected-server"));
        assert_eq!(out.condition.reason, "Waiting");
    }

    #[test]
    fn monitoring() {
        let out = compose(&input(xr(&format!(r#"{{{MODEL},"alerts":{{"waitingRequests":5}}}}"#), "{}"), false, &[])).unwrap();
        let pm = manifest(&out.composed["protected-podmonitor"]);
        assert_eq!(pm["spec"]["selector"]["matchLabels"]["kserve.io/component"], "workload");
        let rules = manifest(&out.composed["protected-prometheusrule"])["spec"]["groups"][0]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 4);
        assert!(rules[1]["expr"].as_str().unwrap().contains("> 5"));
        let d: Value = serde_json::from_str(out.composed["dashboard"].object["spec"]["json"].as_str().unwrap()).unwrap();
        assert_eq!(d["uid"], out.status["dashboardUid"]);
        let out = compose(&input(xr(&format!(r#"{{{MODEL},"alerts":{{"disabled":true}}}}"#), "{}"), false, &[])).unwrap();
        assert!(!out.composed.contains_key("protected-prometheusrule"), "alerts disabled");
    }

    #[test]
    fn served_name_of_a_server() {
        assert_eq!(served_name(&xr(&format!("{{{MODEL}}}"), "{}")), "llama");
        assert_eq!(served_name(&xr(r#"{"model":{"uri":"hf://x/y","name":"x/y"}}"#, "{}")), "x/y");
    }
}
