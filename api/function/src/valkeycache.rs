//! Composes a ValkeyCache (cache.cndev.nl/v1alpha1).
//!
//! The namespaced XR lives in its Project's namespace on the control plane,
//! which runs no caches. Like PostgresCluster, what runs goes to the Project's
//! protected location, each object wrapped in a provider-kubernetes Object for
//! the ClusterProviderConfig named after the location; the password Secret and
//! the GrafanaDashboard (the project's Grafana runs on the control plane) are
//! composed directly:
//!
//!     auth-secret     Secret <name>-valkey: username, password (generated once,
//!                     then kept), host, port, uri. What tenants and the portal read.
//!     auth            Secret <name>-valkey-auth in the location, data and type
//!                     patched from auth-secret (never in the Object spec)
//!     cluster         ValkeyCluster <name> (valkey-io operator): cluster mode, no
//!                     persistence, maxmemory + eviction policy, the default user
//!                     with the password; semantic mode adds the valkey-bundle
//!                     image with valkey-search and the exporter's module metrics
//!     podmonitor      PodMonitor <name>-valkey for the redis_exporter sidecar,
//!                     labelling every series with cluster, shard and node
//!     prometheusrule  PrometheusRule <name>-alerts: the cache alerts
//!                     (monitoring/alerts/valkey-cache-rules.yaml) scoped to this cache
//!     dashboard       GrafanaDashboard <name>-valkey: monitoring/dashboards/valkey-cache.json
//!                     with its own title and uid, preselected on this cache
//!
//! Location: the Project's location for spec.site, protected (default) or
//! recovery (Project spec.locations.<site>, a required resource named after the
//! namespace), pinned in status.location on first use, so a cache never moves
//! and a missing Project never empties the composition.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use k8s_openapi::ByteString;
use k8s_openapi::api::core::v1::Secret;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

use crate::common::kinds::crds::grafana::grafana_dashboard as gd;
use crate::common::kinds::crds::prometheus::pod_monitor::*;
use crate::common::kinds::crds::valkey::valkey_cluster::*;
use crate::common::kinds::{self, Labels, labels_of, location_object, prometheus_rule, quantities, secret_copy, to_value};
use crate::common::lenient::decode;
use crate::common::util::{
    as_str, condition, condition_true, dig_opt, labels_obj, live, new_secret, or, or_i, sha1hex, unb64,
};
use crate::common::{Composed, Condition, Input, Output, Requirement, Result};
use crate::lenient;

/// Images, pinned; bump them together with the operator in ../../../deps/README.md.
pub const IMAGE: &str = "valkey/valkey:9.1.2";
pub const BUNDLE_IMAGE: &str = "valkey/valkey-bundle:9.1.2";
pub const SEARCH_MODULE: &str = "/usr/lib/valkey/libsearch.so";
pub const PORT: i64 = 6379;

/// The requirement name of the Project the composition reads.
pub const REQUIRED_PROJECT: &str = "project";

lenient! {
    pub struct Metadata { pub name: String, pub namespace: String }
}
lenient! {
    pub struct XrStatus { pub location: String }
}
lenient! {
    /// The ValkeyCache XR, as far as the composition reads it. Fields mirror
    /// apis/valkeycache/definition.yaml; the accessors below apply the XRD
    /// defaults again so `crossplane render` and objects created before a
    /// default existed come out the same.
    pub struct Xr { pub metadata: Metadata, pub spec: Spec, pub status: XrStatus }
}
lenient! {
    pub struct ResourceSpec { pub cpu: String, pub memory: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Spec {
        pub site: String,
        pub mode: String,
        pub shards: i64,
        pub replicas: Option<i64>,
        pub resources: ResourceSpec,
        pub max_memory_percent: i64,
        pub eviction_policy: String,
        pub monitoring: Monitoring,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct PrometheusRuleSpec { pub enabled: Option<bool>, pub exclude_rules: Vec<String> }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct GrafanaDashboardSpec {
        pub enabled: Option<bool>,
        pub instance_selector: BTreeMap<String, String>,
        pub allow_cross_namespace_import: bool,
        pub folder: String,
        pub datasource_name: String,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Monitoring {
        pub enabled: Option<bool>,
        pub pod_monitor_labels: BTreeMap<String, String>,
        pub prometheus_rule: PrometheusRuleSpec,
        pub grafana_dashboard: GrafanaDashboardSpec,
    }
}

/// Sites (spec.site): which of the Project's locations the cache runs in.
pub const SITE_PROTECTED: &str = "protected";
/// Modes (spec.mode).
pub const MODE_EXACT: &str = "exact";
pub const MODE_SEMANTIC: &str = "semantic";

impl Spec {
    fn site(&self) -> &str {
        or(&self.site, SITE_PROTECTED)
    }
    fn mode(&self) -> &str {
        or(&self.mode, MODE_EXACT)
    }
    fn semantic(&self) -> bool {
        self.mode() == MODE_SEMANTIC
    }
    fn shards(&self) -> i64 {
        or_i(self.shards, 1)
    }
    fn cpu(&self) -> &str {
        or(&self.resources.cpu, "500m")
    }
    fn memory(&self) -> &str {
        or(&self.resources.memory, "1Gi")
    }
    fn max_memory_pct(&self) -> i64 {
        or_i(self.max_memory_percent, 75)
    }
    fn eviction_policy(&self) -> &str {
        or(&self.eviction_policy, "allkeys-lru")
    }
    fn replicas(&self) -> i64 {
        self.replicas.unwrap_or(1)
    }
}

impl Monitoring {
    fn enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
    fn rules(&self) -> bool {
        self.enabled() && self.prometheus_rule.enabled.unwrap_or(true)
    }
    fn dashboard(&self) -> bool {
        self.grafana_dashboard.enabled.unwrap_or(true)
    }
}

/// What Compose reads besides the XR: the Project named after the XR's namespace.
pub fn requirements(input: &Input) -> BTreeMap<String, Requirement> {
    let ns = as_str(input.xr.pointer("/metadata/namespace"));
    BTreeMap::from([(REQUIRED_PROJECT.into(), Requirement::named("platform.cndev.nl/v1alpha1", "Project", "", ns))])
}

// Vendored sources, prepared by `make generate` (tools/src/bin/generate.rs) from
// monitoring/dashboards/valkey-cache.json and monitoring/alerts/valkey-cache-rules.yaml with
// their placeholders for the namespace, cache name and dashboard uid.
const DASHBOARD_SOURCE: &str = include_str!("../assets/valkeycache/zz_generated.dashboard.json");
const ALERT_RULES_SOURCE: &str = include_str!("../assets/valkeycache/zz_generated.alert-rules.yaml");

/// The generated assets' placeholders: the cluster or cache, its namespace and dashboard uid.
pub fn substitute(text: &str, namespace: &str, name: &str, uid: &str) -> String {
    // One pass, as strings.NewReplacer: a substituted value is never
    // replaced again.
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let pairs = [("zzclusterzz", name), ("zznamespacezz", namespace), ("zzuidzz", uid)];
    'outer: while !rest.is_empty() {
        for (from, to) in pairs {
            if let Some(r) = rest.strip_prefix(from) {
                out.push_str(to);
                rest = r;
                continue 'outer;
            }
        }
        let c = rest.chars().next().expect("not empty");
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// Alert rules from a generated asset, scoped to one workload, without the excluded ones.
pub fn alert_rules(source: &str, namespace: &str, name: &str, exclude: &[String]) -> Result<Vec<Value>> {
    let rules: Vec<Value> = serde_yaml::from_str(&substitute(source, namespace, name, ""))
        .map_err(|e| format!("embedded alert rules: {e}"))?;
    Ok(rules
        .into_iter()
        .filter(|r| !exclude.iter().any(|x| Some(x.as_str()) == r.get("alert").and_then(Value::as_str)))
        .collect())
}

struct Composition<'a> {
    xr: Xr,
    observed: &'a BTreeMap<String, Value>,
    labels: Map<String, Value>,
}

/// Renders the desired state of a ValkeyCache.
pub fn compose(input: &Input) -> Result<Output> {
    let xr: Xr = decode(&input.xr);
    let labels = labels_obj(&[
        ("app.kubernetes.io/managed-by", "crossplane"),
        ("app.kubernetes.io/part-of", "basis"),
        ("cache.cndev.nl/valkeycache", &xr.metadata.name),
    ]);
    let c = Composition { xr, observed: &input.observed, labels };
    let (name, ns) = (c.xr.metadata.name.as_str(), c.xr.metadata.namespace.as_str());
    let spec = &c.xr.spec;
    let mon = &spec.monitoring;

    // ---- location: pinned in status.location, else the Project's protected location
    let site = spec.site();
    let project_location = as_str(dig_opt(input.first(REQUIRED_PROJECT), &["spec", "locations", site]));
    let location = or(&c.xr.status.location, project_location).to_string();
    if location.is_empty() && input.resolved(REQUIRED_PROJECT) && c.running() {
        return Err(format!(
            "ValkeyCache {ns}/{name} has composed resources but no location: neither status.location nor Project {ns} says where it runs"
        ));
    }

    let mut out = Output::default();
    let secret_name = format!("{name}-valkey");
    let copy_name = format!("{name}-valkey-auth");
    let host = format!("valkey-{name}.{ns}.svc");

    // ---- the password: generated once, then read back from the observed Secret
    let mut password = dig_opt(c.observed.get("auth-secret"), &["data", "password"])
        .and_then(Value::as_str)
        .and_then(unb64)
        .unwrap_or_default();
    if password.is_empty() {
        password = new_secret(32);
    }
    let data = [
        ("username", "default".to_string()),
        ("password", password.clone()),
        ("host", host.clone()),
        ("port", PORT.to_string()),
        ("uri", format!("valkey://default:{password}@{host}:{PORT}")),
    ];
    out.composed.insert("auth-secret".into(), Composed { ready: c.observed.contains_key("auth-secret"), object: to_value(&Secret {
        metadata: c.meta(&secret_name, None),
        type_: Some("Opaque".into()),
        data: Some(data.into_iter().map(|(k, v)| (k.to_string(), ByteString(v.into_bytes()))).collect()),
        ..Default::default()
    })});

    let dash_uid = format!("valkey-{}", &sha1hex(&format!("{ns}/{name}"))[..20]);
    if mon.dashboard() {
        out.composed.insert("dashboard".into(), Composed { object: c.dashboard(&dash_uid), ready: c.observed.contains_key("dashboard") });
    }

    let modules: Vec<&str> = if spec.semantic() { vec!["search"] } else { vec![] };
    let mut status = json!({"ready": false, "state": "Pending", "message": "", "shards": 0, "readyShards": 0,
        "site": site, "endpoint": format!("{host}:{PORT}"), "secret": secret_name, "modules": modules});
    if mon.dashboard() {
        status["monitoring"] = json!({"dashboardUid": dash_uid});
    }
    if location.is_empty() {
        let msg = format!("Namespace {ns} is not a Project with a {site} location (Project spec.locations.{site})");
        status["message"] = json!(msg);
        out.status = status;
        out.condition = Condition { status: false, reason: "NoLocation".into(), message: msg };
        return Ok(out);
    }
    status["location"] = json!(location);

    // ---- what the location reports
    let copy_ready = condition_true(c.observed.get("auth"), "Ready");
    lenient! {
        #[serde(rename_all = "camelCase")]
        struct VcStatus { state: String, message: String, shards: i64, ready_shards: i64 }
    }
    let vc: VcStatus = decode(dig_opt(c.observed.get("cluster"), &["status", "atProvider", "manifest", "status"]).unwrap_or(&Value::Null));
    let cluster_ready = vc.state == "Ready";
    let synced = condition(c.observed.get("cluster"), "Synced");
    let reported = |key: &str| live(c.observed.get(key)).is_some();
    let ready: BTreeMap<&str, bool> = BTreeMap::from([
        ("auth", copy_ready),
        ("cluster", cluster_ready),
        ("podmonitor", reported("podmonitor")),
        ("prometheusrule", reported("prometheusrule")),
    ]);

    for (key, obj) in c.location_objects(&copy_name)? {
        let mut w = c.wrap(&key, &location, obj);
        w.ready = ready.get(key.as_str()).copied().unwrap_or(false);
        out.composed.insert(key, w);
    }

    let all_ready = copy_ready && cluster_ready;
    status["ready"] = json!(all_ready);
    status["state"] = json!(or(&vc.state, "Pending"));
    status["shards"] = json!(vc.shards);
    status["readyShards"] = json!(vc.ready_shards);
    let mut cond = Condition { status: all_ready, reason: "Available".into(), message: String::new() };
    let msg = if synced.is_some_and(|s| s.get("status").and_then(Value::as_str) == Some("False")) {
        cond.reason = "ApplyFailed".into();
        format!(
            "Can't apply the ValkeyCluster in location {location} (is the Valkey operator installed there?): {}",
            as_str(synced.and_then(|s| s.get("message")))
        )
    } else if !cluster_ready {
        cond.reason = "Creating".into();
        or(&vc.message, &format!("Waiting for the ValkeyCluster in location {location}")).to_string()
    } else if !copy_ready {
        cond.reason = "Creating".into();
        format!("Copying the password Secret to location {location}")
    } else {
        format!("Cache {name} is ready")
    };
    status["message"] = json!(msg);
    cond.message = msg;
    out.status = status;
    out.condition = cond;
    Ok(out)
}

impl Composition<'_> {
    /// The XR already composes more than what lives on the control plane:
    /// there may be a cache to protect.
    fn running(&self) -> bool {
        self.observed.keys().any(|k| k != "auth-secret" && k != "dashboard")
    }

    /// The manifests for the location, by composition resource name.
    fn location_objects(&self, copy_name: &str) -> Result<BTreeMap<String, Value>> {
        let spec = &self.xr.spec;
        let mon = &spec.monitoring;
        let (name, ns) = (self.xr.metadata.name.as_str(), self.xr.metadata.namespace.as_str());
        let mut out = BTreeMap::new();
        // The copy's data and type come from auth-secret (see wrap).
        out.insert("auth".into(), to_value(&Secret { metadata: self.meta(copy_name, None), ..Default::default() }));

        let memory = spec.memory().to_string();
        let mut vc_spec = ValkeyClusterSpec {
            image: Some(IMAGE.into()),
            shards: spec.shards() as i32,
            replicas: Some(spec.replicas() as i32),
            resources: Some(ValkeyClusterResources {
                requests: Some(quantities(Labels::from([("cpu".to_string(), spec.cpu().to_string()), ("memory".to_string(), memory.clone())]))),
                limits: Some(quantities(Labels::from([("memory".to_string(), memory)]))),
                ..Default::default()
            }),
            config: Some(Labels::from([
                ("maxmemory".to_string(), max_memory(spec.memory(), spec.max_memory_pct())),
                ("maxmemory-policy".to_string(), spec.eviction_policy().to_string()),
            ])),
            users: Some(vec![ValkeyClusterUsers {
                name: "default".into(),
                password_secret: Some(ValkeyClusterUsersPasswordSecret { name: Some(copy_name.into()), keys: Some(vec!["password".into()]) }),
                commands: Some(ValkeyClusterUsersCommands { allow: Some(vec!["@all".into()]), deny: Some(vec!["@admin".into()]) }),
                keys: Some(ValkeyClusterUsersKeys { read_write: Some(vec!["*".into()]), ..Default::default() }),
                channels: Some(ValkeyClusterUsersChannels { patterns: Some(vec!["*".into()]) }),
                ..Default::default()
            }]),
            scheduling: Some(ValkeyClusterScheduling {
                node: Some(ValkeyClusterSchedulingNode { spread: Some(ValkeyClusterSchedulingNodeSpread {
                    shard: Some(ValkeyClusterSchedulingNodeSpreadShard { mode: Some(ValkeyClusterSchedulingNodeSpreadShardMode::Preferred) }),
                    ..Default::default()
                }) }),
                ..Default::default()
            }),
            exporter: Some(ValkeyClusterExporter { enabled: Some(mon.enabled()), ..Default::default() }),
            ..Default::default()
        };
        if spec.semantic() {
            let threads = search_threads(spec.cpu()).to_string();
            vc_spec.image = Some(BUNDLE_IMAGE.into());
            // Appended to the server's valkey-server command (strategic merge patch
            // by name). Every word its own argument: as one, valkey-server takes
            // "<path> --reader-threads ..." for the module's path and aborts. The
            // thread counts are the module's configs (search.*), not its arguments,
            // which must start with "--" and so would be read as server options.
            let args = ["--loadmodule", SEARCH_MODULE, "--search.reader-threads", &threads, "--search.writer-threads", &threads];
            vc_spec.containers = Some(vec![ValkeyClusterContainers { name: "server".into(), args: Some(args.iter().map(|a| a.to_string()).collect()),
                ..Default::default() }]);
            if mon.enabled() {
                // valkey-search's INFO section (index memory, query counts) for the dashboard.
                vc_spec.exporter = Some(ValkeyClusterExporter { enabled: Some(true), args: Some(vec!["--include-modules-metrics".into()]),
                    ..Default::default() });
            }
        }
        out.insert("cluster".into(), to_value(&ValkeyCluster { metadata: self.meta(name, None), spec: vc_spec, status: None }));

        let mon_labels = &mon.pod_monitor_labels;
        if mon.enabled() {
            let relabel = |label: &str, target: &str| PodMonitorPodMetricsEndpointsRelabelings {
                source_labels: Some(vec![format!("__meta_kubernetes_pod_label_{label}")]), target_label: Some(target.into()), ..Default::default()
            };
            let pm = PodMonitor {
                metadata: self.meta(&format!("{name}-valkey"), Some(mon_labels)),
                spec: PodMonitorSpec {
                    selector: PodMonitorSelector { match_labels: Some(Labels::from([("valkey.io/cluster".to_string(), name.to_string())])),
                        ..Default::default() },
                    pod_metrics_endpoints: Some(vec![PodMonitorPodMetricsEndpoints { port: Some("metrics".into()), relabelings: Some(vec![
                        relabel("valkey_io_cluster", "cluster"),
                        relabel("valkey_io_shard_index", "shard"),
                        relabel("valkey_io_node_index", "node"),
                    ]), ..Default::default() }]),
                    ..Default::default()
                },
                status: None,
            };
            out.insert("podmonitor".into(), to_value(&pm));
        }
        if mon.rules() {
            let rules = alert_rules(ALERT_RULES_SOURCE, ns, name, &mon.prometheus_rule.exclude_rules)?;
            out.insert("prometheusrule".into(), to_value(&prometheus_rule(self.meta(&format!("{name}-alerts"), Some(mon_labels)),
                format!("valkey/{ns}/{name}"), kinds::rules(rules)?)));
        }
        Ok(out)
    }

    /// Puts a location object into a provider-kubernetes Object.
    fn wrap(&self, key: &str, location: &str, manifest: Value) -> Composed {
        let (name, ns) = (self.xr.metadata.name.as_str(), self.xr.metadata.namespace.as_str());
        // The Secret's data comes from the control plane, never through this spec.
        let references = if key == "auth" { secret_copy(ns, &format!("{name}-valkey")) } else { vec![] };
        let metadata = kinds::meta(&format!("{name}-{key}"), ns, &labels_of(&self.labels));
        Composed { ready: false, object: to_value(&location_object(metadata, location, manifest, references)) }
    }

    /// The Valkey cache dashboard for this cache: its own title and uid, the
    /// namespace/cluster variables preset.
    fn dashboard(&self, uid: &str) -> Value {
        let (name, ns) = (self.xr.metadata.name.as_str(), self.xr.metadata.namespace.as_str());
        let g = &self.xr.spec.monitoring.grafana_dashboard;
        let selector = if g.instance_selector.is_empty() {
            Labels::from([("dashboards.paas.cndev.nl/scope".to_string(), ns.to_string())])
        } else {
            g.instance_selector.clone()
        };
        to_value(&gd::GrafanaDashboard {
            metadata: self.meta(&format!("{name}-valkey"), None),
            spec: gd::GrafanaDashboardSpec {
                instance_selector: gd::GrafanaDashboardInstanceSelector { match_labels: Some(selector), ..Default::default() },
                allow_cross_namespace_import: Some(g.allow_cross_namespace_import),
                folder: Some(or(&g.folder, "Valkey").into()),
                uid: Some(uid.into()),
                resync_period: Some("10m".into()),
                datasources: Some(vec![gd::GrafanaDashboardDatasources { input_name: "DS_PROMETHEUS".into(),
                    datasource_name: or(&g.datasource_name, "prometheus").into() }]),
                json: Some(substitute(DASHBOARD_SOURCE, ns, name, uid)),
                ..Default::default()
            },
            status: None,
        })
    }

    /// The metadata of one of the cache's objects, extra labels added.
    fn meta(&self, name: &str, extra: Option<&BTreeMap<String, String>>) -> ObjectMeta {
        let mut labels = labels_of(&self.labels);
        labels.extend(extra.into_iter().flatten().map(|(k, v)| (k.clone(), v.clone())));
        kinds::meta(name, &self.xr.metadata.namespace, &labels)
    }
}

/// pct of the memory limit in mb (1024^2 bytes for Valkey).
fn max_memory(memory: &str, pct: i64) -> String {
    let mi = match memory.strip_suffix("Gi") {
        Some(n) => n.parse::<i64>().unwrap_or(0) * 1024,
        None => memory.strip_suffix("Mi").unwrap_or(memory).parse::<i64>().unwrap_or(0),
    };
    format!("{}mb", mi * pct / 100)
}

/// valkey-search's thread pools capped at the pod's CPU (it sizes them to
/// the node's cores otherwise).
fn search_threads(cpu: &str) -> i64 {
    let cores = match cpu.strip_suffix('m') {
        Some(m) => m.parse::<i64>().unwrap_or(0) as f64 / 1000.0,
        None => cpu.parse::<f64>().unwrap_or(0.0),
    };
    let mut threads = cores as i64;
    if (threads as f64) < cores {
        threads += 1;
    }
    threads.max(1)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::util::b64;
    use crate::common::util::set_secret;

    fn input(spec: Value, status: Value, observed: &[(&str, Value)], project: Option<Value>) -> Input {
        let mut required = BTreeMap::new();
        if let Some(p) = project {
            required.insert(REQUIRED_PROJECT.to_string(), if p.is_null() { vec![] } else { vec![p] });
        }
        Input {
            xr: json!({"apiVersion": "cache.cndev.nl/v1alpha1", "kind": "ValkeyCache",
                "metadata": {"name": "llm-cache", "namespace": "demo"}, "spec": spec, "status": status}),
            observed: observed.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            required,
        }
    }

    fn demo() -> Option<Value> {
        Some(json!({"spec": {"locations": {"protected": "si-ske-demo"}}}))
    }

    fn manifest(c: &Composed) -> &Value {
        &c.object["spec"]["forProvider"]["manifest"]
    }

    #[test]
    fn places_everything_in_the_projects_protected_location() {
        set_secret(Some("generated-password-0123456789abcd"));
        let out = compose(&input(json!({}), json!({}), &[], demo())).unwrap();
        for key in ["auth-secret", "auth", "cluster", "podmonitor", "prometheusrule", "dashboard"] {
            assert!(out.composed.contains_key(key), "missing {key}");
        }
        assert_eq!(out.status["location"], "si-ske-demo");
        assert_eq!(out.status["ready"], false);
        assert_eq!(out.condition.reason, "Creating");
        assert_eq!(out.composed["cluster"].object["spec"]["providerConfigRef"]["name"], "si-ske-demo");
    }

    #[test]
    fn site_recovery_runs_in_the_projects_recovery_location() {
        let both = Some(json!({"spec": {"locations": {"protected": "si-ske-demo", "recovery": "onprem-ams"}}}));
        let out = compose(&input(json!({"site": "recovery"}), json!({}), &[], both)).unwrap();
        assert_eq!(out.status["location"], "onprem-ams");
        assert_eq!(out.status["site"], "recovery");
        assert_eq!(out.composed["cluster"].object["spec"]["providerConfigRef"]["name"], "onprem-ams");
        // A Project without a recovery location places nothing.
        let out = compose(&input(json!({"site": "recovery"}), json!({}), &[], demo())).unwrap();
        assert!(out.status.get("location").is_none());
        assert_eq!(out.condition.reason, "NoLocation");
        assert!(!out.composed.contains_key("cluster"));
        assert!(out.status["message"].as_str().unwrap().contains("recovery location"));
    }

    #[test]
    fn keeps_an_existing_password() {
        let observed = [("auth-secret", json!({"data": {"password": b64("kept")}}))];
        let out = compose(&input(json!({}), json!({}), &observed, demo())).unwrap();
        let uri = unb64(out.composed["auth-secret"].object["data"]["uri"].as_str().unwrap()).unwrap();
        assert_eq!(uri, "valkey://default:kept@valkey-llm-cache.demo.svc:6379");
    }

    #[test]
    fn semantic_mode_loads_valkey_search_and_its_metrics() {
        let out = compose(&input(json!({"mode": "semantic", "resources": {"cpu": "2500m", "memory": "2Gi"}, "maxMemoryPercent": 50}),
            json!({}), &[], demo())).unwrap();
        let spec = &manifest(&out.composed["cluster"])["spec"];
        assert_eq!(spec["image"], BUNDLE_IMAGE);
        // Each word its own argument, the threads as the module's configs:
        // valkey-server reads one "<path> --reader-threads ..." argument as the path.
        assert_eq!(spec["containers"][0]["args"],
            json!(["--loadmodule", "/usr/lib/valkey/libsearch.so", "--search.reader-threads", "3", "--search.writer-threads", "3"]));
        assert_eq!(spec["exporter"]["args"], json!(["--include-modules-metrics"]));
        assert_eq!(spec["config"]["maxmemory"], "1024mb");
    }

    #[test]
    fn dashboard_and_alerts_are_scoped_to_the_cache() {
        let out = compose(&input(json!({"monitoring": {"prometheusRule": {"excludeRules": ["ValkeyCacheLowHitRatio"]}}}),
            json!({}), &[], demo())).unwrap();
        let d = &out.composed["dashboard"].object;
        let uid = d["spec"]["uid"].as_str().unwrap();
        assert!(uid.starts_with("valkey-"));
        assert_eq!(out.status["monitoring"]["dashboardUid"], uid);
        let body = d["spec"]["json"].as_str().unwrap();
        assert!(!body.contains("zz") && body.contains("\"Valkey / demo / llm-cache\""), "placeholders not substituted");
        assert_eq!(d["spec"]["instanceSelector"]["matchLabels"]["dashboards.paas.cndev.nl/scope"], "demo");
        let rules = serde_json::to_string(&manifest(&out.composed["prometheusrule"])["spec"]["groups"]).unwrap();
        assert!(!rules.contains("zz") && rules.contains("cluster=\\\"llm-cache\\\""), "rules {rules}");
        assert!(!rules.contains("ValkeyCacheLowHitRatio") && rules.contains("ValkeyCacheDown"), "rules {rules}");
        let pm = serde_json::to_string(manifest(&out.composed["podmonitor"])).unwrap();
        assert!(pm.contains("\"targetLabel\":\"cluster\""), "podmonitor {pm}");
    }

    #[test]
    fn monitoring_off_composes_no_monitor_rules_or_dashboard() {
        let out = compose(&input(json!({"monitoring": {"enabled": false, "grafanaDashboard": {"enabled": false}}}), json!({}), &[], demo())).unwrap();
        for key in ["podmonitor", "prometheusrule", "dashboard"] {
            assert!(!out.composed.contains_key(key), "{key} composed with monitoring off");
        }
    }

    #[test]
    fn ready_once_the_copy_and_the_operator_report_it() {
        let observed = [
            ("auth", json!({"status": {"conditions": [{"type": "Ready", "status": "True"}]}})),
            ("cluster", json!({"status": {"atProvider": {"manifest": {"status": {"state": "Ready", "shards": 1, "readyShards": 1}}}}})),
        ];
        let out = compose(&input(json!({}), json!({}), &observed, demo())).unwrap();
        assert_eq!(out.status["ready"], true);
        assert!(out.condition.status && out.composed["cluster"].ready);
        assert_eq!(out.status["readyShards"], 1);
    }

    #[test]
    fn refuses_to_lose_the_location_of_a_running_cache() {
        let observed = [("cluster", json!({}))];
        assert!(compose(&input(json!({}), json!({}), &observed, Some(Value::Null))).is_err(), "composed a running cache without a location");
        let out = compose(&input(json!({}), json!({"location": "pinned"}), &observed, Some(Value::Null))).unwrap();
        assert_eq!(out.status["location"], "pinned");
    }

    #[test]
    fn helpers() {
        for (i, want) in [("1Gi", "768mb"), ("512Mi", "384mb")] {
            assert_eq!(max_memory(i, 75), want);
        }
        for (i, want) in [("500m", 1), ("1", 1), ("1.5", 2), ("2000m", 2), ("100m", 1)] {
            assert_eq!(search_threads(i), want, "{i}");
        }
        assert_eq!(substitute("zzclusterzz.zznamespacezz/zzuidzz", "ns", "zznamespacezz", "u"), "zznamespacezz.ns/u");
    }
}
