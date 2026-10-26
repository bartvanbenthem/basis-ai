use basis_tools::doc::{self, strs};
use basis_tools::{at, has, l, s};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::{Render, Set, all_strings, eq, list_str, repr, same_keys, set, unb64, union, v};

pub fn assert(r: &Render) {
    let (kase, state, status, name, ns) = (r.kase.as_str(), r.state.as_str(), &r.status, r.name.as_str(), r.ns.as_str());
    let check = |ok: bool, msg: String| r.check(ok, msg);

    // semantic is pinned (status.location); recovery picks the Project's recovery location.
    let location = match kase {
        "minimal" => "si-ske-demo",
        "semantic" | "recovery" => "onprem-ams",
        _ => "",
    };
    let site = if kase == "recovery" { "recovery" } else { "protected" };
    check(s!(status, "site") == site, format!("status.site {:?}, want {site:?}", s!(status, "site")));
    let mut want = set(&["auth-secret", "dashboard"]);
    if !location.is_empty() {
        want = union(&[&want, &set(&["auth", "cluster"])]);
        if kase != "semantic" {
            // monitoring off there; the dashboard stays
            want = union(&[&want, &set(&["podmonitor", "prometheusrule"])]);
        }
    }
    check(same_keys(&r.composed, &want), format!("composed resources {}, want {}", list_str(&r.keys()), list_str(&want)));

    // --- the password Secret on the control plane
    let secret = r.get("auth-secret");
    let mut decoded: BTreeMap<&str, String> = BTreeMap::new();
    for k in ["username", "password", "host", "port", "uri"] {
        let val = unb64(s!(secret, "data", k));
        check(val.as_ref().is_some_and(|v| !v.is_empty()), format!("Secret {}: key {k} missing or not base64", s!(secret, "metadata", "name")));
        decoded.insert(k, val.unwrap_or_default());
    }
    check(s!(secret, "metadata", "name") == format!("{name}-valkey") && s!(secret, "metadata", "namespace") == ns,
        "password Secret must be <name>-valkey in the XR's namespace".into());
    if state == "observed" {
        check(decoded["password"] == "secret-password-0123456789", format!("an existing password must be kept, got {:?}", decoded["password"]));
    } else {
        check(decoded["password"].len() >= 32, format!("generated password too short: {} characters", decoded["password"].len()));
    }
    let host = format!("valkey-{name}.{ns}.svc");
    check(decoded["host"] == host && decoded["port"] == "6379", format!("host/port {}:{}", decoded["host"], decoded["port"]));
    check(decoded["uri"] == format!("valkey://default:{}@{host}:6379", decoded["password"]), format!("uri {:?}", decoded["uri"]));

    // --- the dashboard in the project's Grafana, like PostgresCluster's
    let dash = r.get("dashboard");
    let uid = s!(dash, "spec", "uid");
    check(s!(dash, "kind") == "GrafanaDashboard" && s!(dash, "metadata", "namespace") == ns && s!(dash, "metadata", "name") == format!("{name}-valkey"),
        format!("dashboard: GrafanaDashboard {name}-valkey in {ns}"));
    check(uid.starts_with("valkey-") && uid.len() == "valkey-".len() + 20, format!("dashboard uid {uid:?}"));
    check(s!(status, "monitoring", "dashboardUid") == uid, format!("status.monitoring.dashboardUid {}, want {uid}", repr(at!(status, "monitoring"))));
    check(eq(at!(dash, "spec", "instanceSelector"), json!({"matchLabels": {"dashboards.paas.cndev.nl/scope": ns}})),
        format!("dashboard instanceSelector {}", repr(at!(dash, "spec", "instanceSelector"))));
    check(s!(dash, "spec", "folder") == "Valkey", format!("dashboard folder {:?}", s!(dash, "spec", "folder")));
    check(eq(at!(dash, "spec", "datasources"), json!([{"inputName": "DS_PROMETHEUS", "datasourceName": "prometheus"}])),
        format!("dashboard datasources {}", repr(at!(dash, "spec", "datasources"))));
    let body: Option<Value> = serde_json::from_str(s!(dash, "spec", "json")).ok();
    check(body.is_some(), "dashboard json doesn't parse".into());
    let body = body.unwrap_or(Value::Null);
    check(s!(&body, "uid") == uid && s!(&body, "title") == format!("Valkey / {ns} / {name}"),
        format!("dashboard uid/title {:?} {:?}", s!(&body, "uid"), s!(&body, "title")));
    check(!s!(dash, "spec", "json").contains("zz"), "dashboard placeholders left".into());
    let src = doc::load(&doc::root().join("monitoring").join("dashboards").join("valkey-cache.json").to_string_lossy());
    check(src.as_ref().is_ok_and(|src| l!(&body, "panels").len() == l!(src, "panels").len()),
        "dashboard panels differ from monitoring/dashboards/valkey-cache.json".into());
    for t in l!(&body, "templating", "list") {
        let n = s!(t, "name");
        if n == "namespace" || n == "cluster" {
            let want = if n == "namespace" { ns } else { name };
            check(s!(t, "current", "value") == want, format!("dashboard variable {n} not preset: {}", repr(at!(t, "current"))));
        }
    }

    if location.is_empty() {
        check(!eq(at!(status, "ready"), json!(true)), "a cache without a location can't be ready".into());
        check(s!(status, "message").contains("not a Project with a protected location"), format!("message {:?}", s!(status, "message")));
        check(s!(r.cond("CacheReady"), "reason") == "NoLocation", format!("CacheReady {}", repr(r.conds.get("CacheReady"))));
        return;
    }

    // --- Objects in the location
    for k in r.keys() {
        if k == "auth-secret" || k == "dashboard" {
            // on the control plane
            continue;
        }
        let o = r.get(&k);
        check(s!(o, "kind") == "Object", format!("{k}: must be an Object"));
        check(s!(o, "metadata", "namespace") == ns && s!(o, "metadata", "name") == format!("{name}-{k}"), format!("{k}: name/namespace"));
        check(eq(at!(o, "spec", "providerConfigRef"), json!({"kind": "ClusterProviderConfig", "name": location})),
            format!("{k}: providerConfigRef {}, want location {location}", repr(at!(o, "spec", "providerConfigRef"))));
        check(s!(r.live(&k), "metadata", "namespace") == ns, format!("{k}: must land in the project namespace"));
    }

    // The copy's data comes from the control plane Secret, never through the Object spec.
    let auth = r.get("auth");
    check(!has!(r.live("auth"), "data") && !has!(r.live("auth"), "stringData"), "the password must not be in the Object spec".into());
    let refs = l!(auth, "spec", "references");
    check(refs.len() == 2, format!("auth: want references for data and type, got {}", repr(Some(&Value::Array(refs.to_vec())))));
    for rf in refs {
        let from = v(at!(rf, "patchesFrom"));
        check(s!(from, "name") == format!("{name}-valkey") && s!(from, "namespace") == ns, format!("auth: reference {}", repr(Some(from))));
    }

    let vc = r.live("cluster");
    let spec = v(at!(vc, "spec"));
    check(s!(vc, "kind") == "ValkeyCluster" && s!(vc, "metadata", "name") == name, format!("cluster: ValkeyCluster {name}"));
    check(!has!(spec, "persistence"), "a cache has no persistence".into());
    let users = l!(spec, "users");
    let users_repr = repr(Some(&Value::Array(users.to_vec())));
    check(users.len() == 1 && s!(&users[0], "name") == "default"
        && eq(at!(&users[0], "passwordSecret"), json!({"name": format!("{name}-valkey-auth"), "keys": ["password"]})),
        format!("the default user must need the generated password: {users_repr}"));
    check(eq(at!(v(users.first()), "commands", "deny"), json!(["@admin"])), "the app user must not get @admin".into());

    // (image, maxmemory, policy, shards, replicas, exporter, args)
    let (image, maxmemory, policy, shards, replicas, exporter, args) = match kase {
        "minimal" | "recovery" => ("valkey/valkey:9.1.2", "768mb", "allkeys-lru", 1, 1, true, None),
        "semantic" => ("valkey/valkey-bundle:9.1.2", "1228mb", "allkeys-lfu", 3, 2, false,
            Some(json!(["--loadmodule", "/usr/lib/valkey/libsearch.so", "--search.reader-threads", "2", "--search.writer-threads", "2"]))),
        // semantic with monitoring on would add the exporter's --include-modules-metrics (unit tests).
        _ => ("", "", "", 0, 0, false, None),
    };
    check(s!(spec, "image") == image, format!("image {}, want {image}", s!(spec, "image")));
    check(eq(at!(spec, "shards"), json!(shards)) && eq(at!(spec, "replicas"), json!(replicas)),
        format!("shards/replicas {}/{}", repr(at!(spec, "shards")), repr(at!(spec, "replicas"))));
    check(eq(at!(spec, "config"), json!({"maxmemory": maxmemory, "maxmemory-policy": policy})), format!("config {}", repr(at!(spec, "config"))));
    check(eq(at!(spec, "exporter", "enabled"), json!(exporter)), format!("exporter {}", repr(at!(spec, "exporter"))));
    match args {
        None => check(!has!(spec, "containers"), format!("an exact cache loads no modules: {}", repr(at!(spec, "containers")))),
        Some(args) => {
            let containers = l!(spec, "containers");
            check(containers.len() == 1 && s!(&containers[0], "name") == "server" && eq(at!(&containers[0], "args"), args),
                format!("semantic: the server must load valkey-search: {}", repr(Some(&Value::Array(containers.to_vec())))));
        }
    }
    if r.composed.contains_key("podmonitor") {
        let pm = r.live("podmonitor");
        check(eq(at!(pm, "spec", "selector", "matchLabels"), json!({"valkey.io/cluster": name})), "podmonitor selector".into());
        let endpoints = l!(pm, "spec", "podMetricsEndpoints");
        check(endpoints.len() == 1 && s!(&endpoints[0], "port") == "metrics", format!("podmonitor endpoints {}", repr(Some(&Value::Array(endpoints.to_vec())))));
        // The dashboard and alerts select on these labels.
        let targets: BTreeMap<String, String> = l!(v(endpoints.first()), "relabelings").iter()
            .map(|rl| (s!(rl, "targetLabel").to_string(), strs(at!(rl, "sourceLabels")).into_iter().next().unwrap_or_default())).collect();
        for (target, source) in [("cluster", "__meta_kubernetes_pod_label_valkey_io_cluster"),
            ("shard", "__meta_kubernetes_pod_label_valkey_io_shard_index"), ("node", "__meta_kubernetes_pod_label_valkey_io_node_index")]
        {
            let got = targets.get(target).map(String::as_str).unwrap_or("");
            check(got == source, format!("podmonitor relabeling to {target}: {got:?}, want {source:?}"));
        }
    }
    if r.composed.contains_key("prometheusrule") {
        let pr = r.live("prometheusrule");
        let groups = l!(pr, "spec", "groups");
        check(groups.len() == 1 && s!(&groups[0], "name") == format!("valkey/{ns}/{name}"), format!("prometheusrule groups {}", repr(Some(&Value::Array(groups.to_vec())))));
        let mut alerts = Set::new();
        for rule in l!(v(groups.first()), "rules") {
            alerts.insert(s!(rule, "alert").to_string());
            let expr = s!(rule, "expr");
            check(expr.contains(&format!("namespace=\"{ns}\"")) && expr.contains(&format!("cluster=\"{name}\"")),
                format!("{}: not scoped to the cache: {expr}", s!(rule, "alert")));
            check(s!(rule, "labels", "namespace") == ns, format!("{}: namespace label", s!(rule, "alert")));
        }
        check(alerts.contains("ValkeyCacheDown") && alerts.contains("ValkeyCacheClusterStateNotOk") && alerts.contains("ValkeyCacheWritesRejected"),
            format!("prometheusrule alerts {}", list_str(&alerts)));
        check(!all_strings(pr).contains("zz"), "alert placeholders left".into());
    }

    // --- status
    check(s!(status, "location") == location && s!(status, "secret") == format!("{name}-valkey") && s!(status, "endpoint") == format!("{host}:6379"),
        format!("status location/secret/endpoint {}", repr(Some(status))));
    let modules = if kase == "semantic" { json!(["search"]) } else { json!([]) };
    check(eq(at!(status, "modules"), modules), format!("modules {}", repr(at!(status, "modules"))));
    let ready = kase == "minimal" && state == "observed";
    check(eq(at!(status, "ready"), json!(ready)), format!("ready {}, want {ready}", repr(at!(status, "ready"))));
    let want_cond = if ready { "True" } else { "False" };
    check(s!(r.cond("Ready"), "status") == want_cond, format!("XR Ready {}, want {want_cond}", repr(r.conds.get("Ready"))));
    check(s!(r.cond("CacheReady"), "status") == want_cond, format!("CacheReady {}", repr(r.conds.get("CacheReady"))));
    if kase == "semantic" && state == "observed" {
        check(s!(r.cond("CacheReady"), "reason") == "ApplyFailed" && s!(status, "message").contains("Valkey operator installed"),
            format!("a missing operator must say so: {}", s!(status, "message")));
    }
}
