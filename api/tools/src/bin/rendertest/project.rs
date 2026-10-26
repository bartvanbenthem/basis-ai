use basis_tools::doc::{equal, is_int, keys, strs};
use basis_tools::{at, has, l, m, s};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::{Render, Set, eq, list_str, prefixed, repr, same_keys, set, unb64, union, v};

/// On the control plane: the namespace (the PostgresCluster XRs live
/// there), a Prometheus that only receives, Grafana. Namespaced objects only
/// once the namespace exists.
fn hub() -> Set {
    set(&["namespace", "prometheus-serviceaccount", "prometheus", "prometheus-pvc", "grafana", "grafana-datasource"])
}

/// In each location, wrapped in an Object named location-<location>-<name>:
/// the namespace, a Prometheus that scrapes, access and quota. Rendered once
/// the namespace on the control plane exists (the Objects live in it).
fn remote_set() -> Set {
    set(&["namespace", "prometheus-clusterrolebinding", "prometheus-serviceaccount", "prometheus", "prometheus-pvc"])
}

/// With a backup bucket, in each location: its keys and the CronJob that
/// checks it reaches the bucket.
fn check_set() -> Set {
    set(&["backup-check-s3", "backup-check"])
}

fn at_loc(location: &str, keys: &Set) -> Set {
    prefixed(&format!("location-{location}-"), keys)
}

fn expected(kase: &str, state: &str) -> Option<Set> {
    let usage2 = || set(&["usage-location-si-ske-demo", "usage-location-onprem-ams"]);
    Some(match (kase, state) {
        ("bare", "empty") | ("minimal", "empty") | ("governed", "empty") => set(&["namespace", "usage-location-si-ske-demo"]),
        ("minimal", "observed") => union(&[&hub(), &set(&["usage-location-si-ske-demo"]), &at_loc("si-ske-demo", &remote_set())]),
        ("full", "empty") | ("sites", "empty") => union(&[&set(&["namespace"]), &usage2()]),
        ("full", "observed") => {
            let site = union(&[&remote_set(), &set(&["access-0", "access-1", "quota", "limitrange"])]);
            union(&[&hub(), &set(&["access-0", "access-1"]), &usage2(), &at_loc("si-ske-demo", &site), &at_loc("onprem-ams", &site)])
        }
        ("sites", "observed") => {
            let site = union(&[&remote_set(), &set(&["access-0", "quota", "limitrange"])]);
            union(&[&hub(), &set(&["access-0", "prometheus-remote-write"]), &usage2(), &at_loc("si-ske-demo", &site), &at_loc("onprem-ams", &site)])
        }
        // COSI: the project's BucketClass from the start; the claim and an
        // access per location once the project namespace exists.
        ("bucket", "empty") | ("granting", "empty") | ("bucket-long", "empty") => union(&[&set(&["namespace", "backup-bucketclass"]), &usage2()]),
        ("bucket", "observed") => {
            let site = union(&[&remote_set(), &check_set()]);
            union(&[&hub(), &usage2(), &set(&["backup-bucketclass", "backup-bucket", "backup-access-si-ske-demo", "backup-access-onprem-ams",
                "backup-sa-si-ske-demo", "backup-sa-onprem-ams", "backup-s3-si-ske-demo", "backup-s3-onprem-ams"]),
                &at_loc("si-ske-demo", &site), &at_loc("onprem-ams", &site)])
        }
        // The same while COSI grants si-ske-demo's access: onprem-ams's waits for it.
        ("granting", "observed") => {
            let site = union(&[&remote_set(), &check_set()]);
            union(&[&hub(), &usage2(), &set(&["backup-bucketclass", "backup-bucket", "backup-access-si-ske-demo",
                "backup-sa-si-ske-demo", "backup-sa-onprem-ams", "backup-s3-si-ske-demo", "backup-s3-onprem-ams"]),
                &at_loc("si-ske-demo", &site), &at_loc("onprem-ams", &site)])
        }
        // No Location "nowhere": no ClusterUsage for it, and the Project isn't ready.
        ("unregistered", "empty") => set(&["namespace"]),
        // minimal with governance and the price catalog: the cost rules and dashboard.
        ("governed", "observed") => union(&[&hub(), &set(&["usage-location-si-ske-demo", "cost-rules", "cost-dashboard"]),
            &at_loc("si-ske-demo", &remote_set())]),
        _ => return None,
    })
}

pub fn assert(r: &Render) {
    let (kase, state, status, name, xr) = (r.kase.as_str(), r.state.as_str(), &r.status, r.name.as_str(), &r.xr);
    let check = |ok: bool, msg: String| r.check(ok, msg);
    let Some(expected) = expected(kase, state) else {
        check(false, format!("no expectations for case {kase}/{state}"));
        return;
    };
    check(same_keys(&r.composed, &expected), format!("composed resources {} != expected {}", list_str(&r.keys()), list_str(&expected)));

    // --- namespace: the labels PostgresClusters and Backstage key on
    let ns = r.get("namespace");
    let labels = v(at!(ns, "metadata", "labels"));
    check(s!(ns, "metadata", "name") == name, "namespace name must equal the project name".into());
    check(s!(labels, "platform.cndev.nl/project") == name, "namespace missing platform.cndev.nl/project label".into());
    check(s!(labels, "dashboards.paas.cndev.nl/scope") == name,
        "namespace scope label must match the PostgresCluster dashboards' default instanceSelector".into());
    check(s!(labels, "pod-security.kubernetes.io/enforce") == "baseline", "pod security baseline not enforced".into());
    let owner = s!(xr, "spec", "owner");
    if !owner.is_empty() {
        check(s!(labels, "backstage.io/owner") == owner, "owner label not set on namespace".into());
    }
    for key in r.keys() {
        let o = r.get(&key);
        if key != "namespace" && !key.starts_with("usage-") && key != "backup-bucketclass" {
            check(s!(o, "metadata", "namespace") == name, format!("{key}: not in the project namespace"));
        }
        check(s!(o, "metadata", "labels", "platform.cndev.nl/project") == name, format!("{key}: missing project label"));
    }
    // --- governance: labels the admission policies read, status, cost rules
    let gov = v(at!(status, "governance"));
    let (mut classification, mut environment) = ("internal", "production");
    if kase == "governed" {
        (classification, environment) = ("confidential", "sandbox");
        check(s!(labels, "platform.cndev.nl/cost-center") == "CC-4711" && s!(gov, "costCenter") == "CC-4711"
            && eq(at!(gov, "expired"), json!(false)) && s!(gov, "currency") == "EUR", format!("governance status {}", repr(Some(gov))));
    }
    check(s!(labels, "platform.cndev.nl/classification") == classification && s!(labels, "platform.cndev.nl/environment") == environment
        && s!(gov, "classification") == classification, format!("classification and environment labels {}", repr(Some(labels))));
    check(!has!(labels, "platform.cndev.nl/expired"), "not expired".into());
    if let Some(rules) = r.composed.get("cost-rules") {
        let groups = l!(rules, "spec", "groups");
        check(groups.len() == 2 && s!(&groups[0], "name") == "basis-cost" && s!(&groups[1], "name") == "basis-budget",
            format!("cost rules and budget alerts: {}", repr(Some(&Value::Array(groups.to_vec())))));
        check(eq(at!(r.get("prometheus"), "spec", "ruleNamespaceSelector", "matchLabels", "kubernetes.io/metadata.name"), json!(name)),
            "the control-plane Prometheus evaluates the project's cost rules".into());
    }

    let sites = v(at!(xr, "spec", "locations"));
    // In the order of sites.values().
    let mut site_locs = vec![s!(sites, "protected").to_string()];
    if has!(sites, "recovery") {
        site_locs.push(s!(sites, "recovery").to_string());
    }
    let ann = v(at!(ns, "metadata", "annotations"));
    check(eq(at!(ann, "platform.cndev.nl/protected-location"), v(at!(sites, "protected")).clone())
        && eq(at!(ann, "platform.cndev.nl/recovery-location"), v(at!(sites, "recovery")).clone()),
        format!("namespace must record the project's sites for the admission policy: {}", repr(Some(ann))));
    check(!has!(ann, "platform.cndev.nl/locations"), "the old location list annotation is gone".into());
    check(!has!(status, "locationNames"), "status.locationNames is gone".into());
    // The Location of si-ske-demo (required/sites.yaml) says schedulable: false.
    let unschedulable = if kase == "sites" { json!("si-ske-demo") } else { Value::Null };
    check(eq(at!(ann, "platform.cndev.nl/unschedulable-locations"), unschedulable),
        "namespace must list the locations closed to new databases for the admission policy".into());

    // --- the COSI backup bucket
    let bucket_case = ["bucket", "bucket-long", "granting"].contains(&kase);
    check((s!(ann, "platform.cndev.nl/backup-bucket") == "true") == bucket_case,
        "namespace must say whether the project has a backup bucket, for the admission policy".into());
    // COSI names the bucket <class><claim UID>: the class gets 63 - 36 characters.
    let mut bucket_class = format!("project-{name}-backups");
    if bucket_class.len() > 27 {
        let sum = hex::encode(Sha256::digest(name.as_bytes()));
        bucket_class = format!("prj-{}-{}", name[..name.len().min(16)].trim_end_matches('-'), &sum[..6]);
    }
    if bucket_case {
        assert_bucket(r, &bucket_class, sites, &site_locs);
    } else {
        check(!has!(status, "backup"), "no backup status without COSI classes".into());
    }

    // --- registered locations: a ClusterUsage each, so the Location can't be deleted
    for key in r.keys() {
        let Some(loc) = key.strip_prefix("usage-location-") else { continue };
        let o = r.get(&key);
        check(s!(o, "kind") == "ClusterUsage" && s!(o, "apiVersion") == "protection.crossplane.io/v1beta1", format!("{key}: must be a ClusterUsage"));
        check(eq(at!(o, "spec", "of"), json!({"apiVersion": "platform.cndev.nl/v1alpha1", "kind": "Location", "resourceRef": {"name": loc}})),
            format!("{key}: spec.of {}", repr(at!(o, "spec", "of"))));
        check(s!(o, "spec", "reason").contains(name), format!("{key}: reason must name the project"));
    }

    // --- locations: Objects for the location's ClusterProviderConfig
    // site -> key without the location prefix -> Object
    let mut remote: BTreeMap<&str, BTreeMap<String, &Value>> = BTreeMap::new();
    let mut site_names = vec!["protected"];
    if has!(sites, "recovery") {
        site_names.push("recovery");
    }
    for site in &site_names {
        let loc = s!(sites, *site);
        let prefix = format!("location-{loc}-");
        let objs: BTreeMap<String, &Value> = r.composed.iter()
            .filter_map(|(k, o)| k.strip_prefix(&prefix).map(|rest| (rest.to_string(), o))).collect();
        for (key, o) in &objs {
            check(s!(o, "kind") == "Object", format!("{loc}/{key}: objects in a location must be Objects"));
            check(eq(at!(o, "spec", "providerConfigRef"), json!({"kind": "ClusterProviderConfig", "name": loc})), format!("{loc}/{key}: providerConfigRef"));
            let manifest = v(at!(o, "spec", "forProvider", "manifest"));
            let leaked: Vec<&str> = m!(manifest, "metadata", "annotations").map(keys).unwrap_or_default().into_iter()
                .filter(|a| a.contains("crossplane.io/") || *a == "platform.cndev.nl/orphan").collect();
            check(leaked.is_empty(), format!("{loc}/{key}: composition annotations leaked into the manifest: {leaked:?}"));
            if key != "namespace" && key != "prometheus-clusterrolebinding" {
                check(s!(manifest, "metadata", "namespace") == name, format!("{loc}/{key}: not in the project namespace there"));
            }
            let policies = at!(o, "spec", "managementPolicies");
            if key == "namespace" {
                let p = strs(policies);
                check(!p.is_empty() && !p.iter().any(|x| x == "Delete" || x == "*"),
                    format!("{loc}: the namespace in a location must never be deleted by Crossplane"));
            } else {
                check(policies.is_none_or(Value::is_null), format!("{loc}/{key}: only the namespace is orphaned"));
            }
        }
        remote.insert(site, objs);
    }
    for key in r.keys() {
        if !key.starts_with("location-") {
            check(s!(r.get(&key), "kind") != "Object", format!("{key}: control-plane objects are composed directly"));
        }
    }
    check(!r.composed.contains_key("prometheus-clusterrolebinding") && !r.composed.contains_key("quota") && !r.composed.contains_key("limitrange"),
        "the control plane scrapes nothing and runs no databases: no Prometheus binding, no quota".into());

    // --- observability wiring
    for site in &site_names {
        let (objs, loc) = (&remote[site], s!(sites, *site));
        if let Some(o) = objs.get("prometheus-clusterrolebinding") {
            let manifest = v(at!(o, "spec", "forProvider", "manifest"));
            check(s!(manifest, "roleRef", "name") == "basis:project-prometheus", "CRB must bind the shared ClusterRole".into());
            check(eq(at!(manifest, "subjects"), json!([{"kind": "ServiceAccount", "name": "prometheus", "namespace": name}])),
                "CRB subject must be the project's prometheus ServiceAccount".into());
        }
        let Some(o) = objs.get("prometheus") else { continue };
        let prom = v(at!(o, "spec", "forProvider", "manifest", "spec"));
        check(s!(prom, "serviceAccountName") == "prometheus", "Prometheus must use its ServiceAccount".into());
        let pm_ns = at!(prom, "podMonitorNamespaceSelector", "matchExpressions", 0, "values");
        check(eq(at!(prom, "podMonitorSelector"), json!({})) && eq(pm_ns, json!([name, "cnpg-system"])),
            "Prometheus must scrape this namespace's and the CNPG operator's PodMonitors".into());
        let rule_ns = at!(prom, "ruleNamespaceSelector", "matchExpressions", 0, "values");
        if kase == "full" {
            check(s!(prom, "retention") == "30d", "retention not passed through".into());
            let vct = v(at!(prom, "storage", "volumeClaimTemplate", "spec"));
            check(s!(vct, "storageClassName") == "fast" && s!(vct, "resources", "requests", "storage") == "50Gi", "Prometheus storage not passed through".into());
            // From the EnvironmentConfig.
            check(eq(rule_ns, json!([name, "monitoring"])), format!("ruleNamespaceSelector {}", repr(rule_ns)));
            check(eq(at!(prom, "serviceMonitorSelector", "matchLabels"), json!({"release": "kps"})), "serviceMonitorLabels from env".into());
            check(eq(at!(prom, "serviceMonitorSelector", "matchExpressions", 0, "values"), json!(["kube-prometheus-stack-apiserver"])),
                "excludeApps from env".into());
        } else {
            check(eq(rule_ns, json!([name, "prometheus-operator-system"])), format!("default ruleNamespaceSelector {}", repr(rule_ns)));
            check(eq(at!(prom, "serviceMonitorSelector", "matchLabels"), json!({"release": "prometheus-operator"})), "default serviceMonitorLabels".into());
        }
        check(eq(at!(prom, "externalLabels"), json!({"location": loc, "site": site})),
            format!("{loc}: Prometheus must label its location and site: {}", repr(at!(prom, "externalLabels"))));
        let want_rw = if kase == "sites" { json!([{"url": format!("https://prometheus-{name}.example.com/api/v1/write")}]) } else { Value::Null };
        check(eq(at!(prom, "remoteWrite"), want_rw), format!("{loc}: remoteWrite {}", repr(at!(prom, "remoteWrite"))));
        check(!has!(prom, "enableRemoteWriteReceiver"), "only the control plane's Prometheus receives".into());
    }

    if let Some(o) = r.composed.get("prometheus") {
        let prom = v(at!(o, "spec"));
        check(eq(at!(prom, "enableRemoteWriteReceiver"), json!(true)), "the control plane's Prometheus receives remote writes".into());
        let cost_rules = r.composed.contains_key("cost-rules");
        // With the price catalog it evaluates the project's cost rules, still scraping nothing.
        let scraping: Vec<&str> = m!(prom).map(keys).unwrap_or_default().into_iter()
            .filter(|k| !(cost_rules && (*k == "ruleSelector" || *k == "ruleNamespaceSelector")) && k.ends_with("Selector")).collect();
        check(scraping.is_empty(), format!("the control plane's Prometheus scrapes nothing: {scraping:?}"));
        check(!has!(prom, "externalLabels") && !has!(prom, "remoteWrite"), "the control plane's Prometheus only receives".into());
    }

    if let Some(pvc) = r.composed.get("prometheus-pvc") {
        // Must be the claim the StatefulSet's volumeClaimTemplate resolves
        // to, or Prometheus would get a second, unmanaged volume.
        check(s!(pvc, "metadata", "name") == "prometheus-prometheus-db-prometheus-prometheus-0", "PVC name".into());
        let vct = v(at!(r.get("prometheus"), "spec", "storage", "volumeClaimTemplate", "spec"));
        check(eq(at!(pvc, "spec", "resources"), v(at!(vct, "resources")).clone()), "PVC size must match the volumeClaimTemplate".into());
        check(eq(at!(pvc, "spec", "storageClassName"), v(at!(vct, "storageClassName")).clone()), "PVC storageClass".into());
    }

    if let Some(ing) = r.composed.get("prometheus-remote-write") {
        let rule = v(at!(ing, "spec", "rules", 0));
        check(s!(rule, "host") == format!("prometheus-{name}.example.com"), "remote-write ingress host".into());
        let paths: Vec<Value> = l!(rule, "http", "paths").iter().map(|p| json!([v(at!(p, "path")), v(at!(p, "pathType"))])).collect();
        check(equal(&Value::Array(paths), &json!([["/api/v1/write", "Exact"]])), "the remote-write ingress must expose only /api/v1/write".into());
        check(s!(ing, "metadata", "annotations", "nginx.ingress.kubernetes.io/whitelist-source-range") == "192.0.2.0/24",
            "ingress annotations from project-defaults".into());
        check(s!(status, "prometheus", "remoteWriteUrl") == format!("https://prometheus-{name}.example.com/api/v1/write"),
            "status.prometheus.remoteWriteUrl".into());
    }

    if let Some(graf) = r.composed.get("grafana") {
        check(s!(graf, "metadata", "labels", "dashboards.paas.cndev.nl/scope") == name, "Grafana must carry the scope label dashboards select on".into());
        check(s!(graf, "spec", "config", "security", "allow_embedding") == "true", "embedding must be allowed".into());
        let host = match kase {
            "minimal" | "governed" => "grafana-demo.10.0.0.1.nip.io",
            "full" => "grafana-team-payments.example.com",
            "sites" => "grafana-team-ledger.example.com",
            _ => "",
        };
        if host.is_empty() {
            // no Grafana ingress in this case's project-defaults
            check(!has!(graf, "spec", "ingress") && !has!(status, "grafana", "url"), "no ingress without hostTemplate".into());
        } else {
            let got = s!(graf, "spec", "ingress", "spec", "rules", 0, "host");
            check(got == host, format!("ingress host {got:?} != {host:?}"));
            if kase == "full" {
                check(eq(at!(graf, "spec", "ingress", "spec", "tls"), json!([{"hosts": [host], "secretName": "wildcard-example-com"}])), "TLS from env".into());
                check(s!(status, "grafana", "url") == format!("https://{host}"), "status.grafana.url must use https".into());
            } else {
                check(s!(status, "grafana", "url") == format!("http://{host}"), "status.grafana.url".into());
            }
        }
    }

    if let Some(o) = r.composed.get("grafana-datasource") {
        let ds = v(at!(o, "spec"));
        check(s!(ds, "datasource", "name") == "prometheus", "datasource must be named 'prometheus'".into());
        check(s!(ds, "datasource", "url") == format!("http://prometheus-operated.{name}.svc:9090"), "datasource url".into());
        check(eq(at!(ds, "instanceSelector", "matchLabels"), json!({"dashboards.paas.cndev.nl/scope": name})), "datasource selector".into());
    }

    // --- access and quota: access on the control plane and in each location, quota only in the locations
    if kase == "full" && state == "observed" {
        let mut places: Vec<(String, BTreeMap<&str, &Value>)> = vec![("control plane".into(),
            ["access-0", "access-1"].into_iter().map(|k| (k, r.get(k))).collect())];
        for site in &site_names {
            let objs = ["access-0", "access-1"].into_iter()
                .filter_map(|k| remote[site].get(k).map(|o| (k, v(at!(o, "spec", "forProvider", "manifest"))))).collect();
            places.push((s!(sites, *site).to_string(), objs));
        }
        for (place, objs) in &places {
            let mut bindings = Map::new();
            let mut names = Set::new();
            for k in ["access-0", "access-1"] {
                let o = v(objs.get(k).copied());
                bindings.insert(s!(o, "roleRef", "name").into(), v(at!(o, "subjects", 0, "name")).clone());
                names.insert(s!(o, "metadata", "name").to_string());
            }
            let bindings = Value::Object(bindings);
            check(equal(&bindings, &json!({"edit": "payments-devs", "view": "auditors"})), format!("{place}: RoleBindings {}", repr(Some(&bindings))));
            check(names.len() == 2, "RoleBinding names must be unique".into());
        }
        for site in &site_names {
            let hard = at!(v(remote[site].get("quota").copied()), "spec", "forProvider", "manifest", "spec", "hard");
            check(eq(hard, json!({"requests.cpu": "8", "requests.memory": "32Gi", "limits.memory": "32Gi", "requests.storage": "200Gi"})),
                format!("{}: quota {}", s!(sites, *site), repr(hard)));
        }
    }

    // --- readiness / status
    check(s!(status, "namespace") == name, "status.namespace".into());
    if kase == "bare" {
        check(!has!(status, "prometheus") && !has!(status, "grafana"), "disabled components must not be in status".into());
    }
    if kase == "unregistered" {
        let msg = "no Location nowhere; register the cluster first";
        check(s!(status, "message") == msg, format!("status.message {}", repr(at!(status, "message"))));
        let locations = at!(status, "locations").cloned().unwrap_or_else(|| json!([]));
        check(equal(&locations, &json!([{"location": "nowhere", "site": "protected", "ready": false, "message": msg}])),
            format!("status.locations {}", repr(at!(status, "locations"))));
    }
    if state == "empty" {
        check(eq(at!(status, "ready"), json!(false)), "status.ready should be false before anything exists".into());
        check(s!(r.cond("Ready"), "status") == "False", "XR Ready should be False".into());
        check(s!(r.cond("ObservabilityReady"), "status") == "False", "ObservabilityReady should be False".into());
    } else if kase == "granting" {
        check(eq(at!(status, "ready"), json!(false)) && s!(status, "message") == "Waiting for COSI to grant backup bucket access in si-ske-demo, onprem-ams",
            format!("status {}", repr(at!(status, "message"))));
        check(s!(r.cond("Ready"), "status") == "False", format!("XR Ready waits for the BucketAccess: {}", repr(r.conds.get("Ready"))));
    } else if kase != "bucket" {
        check(eq(at!(status, "ready"), json!(true)), format!("status.ready should be true, got {}", repr(at!(status, "ready"))));
        check(s!(r.cond("Ready"), "status") == "True", format!("XR Ready should be True, got {}", repr(r.conds.get("Ready"))));
        check(s!(r.cond("ObservabilityReady"), "status") == "True", "ObservabilityReady should be True".into());
        check(s!(status, "prometheus", "url") == format!("http://prometheus-operated.{name}.svc:9090"), "status.prometheus.url".into());
        let want: Vec<Value> = site_names.iter().map(|site| json!([s!(sites, *site), site, true])).collect();
        let got: Vec<Value> = l!(status, "locations").iter().map(|l| json!([v(at!(l, "location")), v(at!(l, "site")), v(at!(l, "ready"))])).collect();
        check(equal(&Value::Array(got), &Value::Array(want)), format!("status.locations {}", repr(at!(status, "locations"))));
        if kase != "sites" && r.composed.contains_key("prometheus") {
            check(s!(status, "message").contains("Grafana shows none"),
                format!("without remote write the message must say Grafana stays empty: {}", repr(at!(status, "message"))));
        }
    }
}

fn assert_bucket(r: &Render, bucket_class: &str, sites: &Value, site_locs: &[String]) {
    let (kase, state, status, name) = (r.kase.as_str(), r.state.as_str(), &r.status, r.name.as_str());
    let check = |ok: bool, msg: String| r.check(ok, msg);

    check((kase == "bucket-long") == bucket_class.starts_with("prj-"), format!("case {kase} must exercise its class form: {bucket_class}"));
    let cls = r.get("backup-bucketclass");
    check(s!(cls, "metadata", "name").len() <= 27, format!("BucketClass name too long for a bucket name: {}", s!(cls, "metadata", "name")));
    check(s!(cls, "kind") == "BucketClass" && s!(cls, "metadata", "name") == bucket_class && !has!(cls, "metadata", "namespace")
        && s!(cls, "deletionPolicy") == "Retain" && s!(cls, "driverName") == "cloudian-cosi-driver"
        && eq(at!(cls, "parameters"), json!({"storagePolicy": "replicated-3"})),
        format!("BucketClass must keep the backups (Retain) and use the driver from project-defaults: {}", repr(Some(cls))));
    if state == "observed" {
        let claim = r.get("backup-bucket");
        check(s!(claim, "kind") == "BucketClaim" && s!(claim, "metadata", "name") == "backups"
            && eq(at!(claim, "spec"), json!({"bucketClassName": bucket_class, "protocols": ["S3"]})), format!("BucketClaim {}", repr(Some(claim))));
        for loc in site_locs {
            if kase == "granting" && loc == s!(sites, "recovery") {
                continue;
            }
            let acc = r.get(&format!("backup-access-{loc}"));
            check(s!(acc, "kind") == "BucketAccess" && s!(acc, "metadata", "name") == format!("backups-{loc}")
                && eq(at!(acc, "spec"), json!({"bucketClaimName": "backups", "bucketAccessClassName": "backups-keys",
                    "credentialsSecretName": format!("cosi-backups-{loc}"), "serviceAccountName": format!("backups-{loc}"), "protocol": "S3"})),
                format!("{loc}: BucketAccess {}", repr(at!(acc, "spec"))));
            let sa = r.get(&format!("backup-sa-{loc}"));
            check(s!(sa, "kind") == "ServiceAccount" && s!(sa, "metadata", "name") == format!("backups-{loc}")
                && s!(sa, "metadata", "namespace") == name && eq(at!(sa, "automountServiceAccountToken"), json!(false)),
                format!("{loc}: the IAM access class needs a ServiceAccount: {}", repr(Some(sa))));
        }
    }
    let backup = v(at!(status, "backup"));
    check(!has!(backup, "namespace") || s!(backup, "namespace") == name, format!("status.backup {}", repr(Some(backup))));
    if state == "empty" {
        let creds = at!(backup, "credentials");
        check(eq(at!(backup, "ready"), json!(false)) && (creds.is_none_or(Value::is_null) || eq(creds, json!({})) || eq(creds, json!([]))),
            format!("status.backup {}", repr(Some(backup))));
        check(s!(status, "message").contains("the backup bucket (COSI)"), format!("message {}", repr(at!(status, "message"))));
    } else {
        // COSI's Secrets are namespaced: they come back in .requiredResources only.
        let want_creds: Map<String, Value> = site_locs.iter().map(|l| (l.clone(), json!(format!("backup-s3-{l}")))).collect();
        check(eq(at!(backup, "ready"), json!(true)) && s!(backup, "bucket") == format!("{name}-backups-0f3a")
            && s!(backup, "destinationPath") == format!("s3://{name}-backups-0f3a/barman") && s!(backup, "endpoint") == "https://s3.example.com"
            && s!(backup, "region") == "region-1" && eq(at!(backup, "credentials"), Value::Object(want_creds)),
            format!("status.backup {}", repr(Some(backup))));
        check(!s!(status, "message").contains("the backup bucket (COSI)"), format!("message {}", repr(at!(status, "message"))));
    }
    // The inventory of backup folders: kept from the last status (old-db's
    // cluster is gone, its folder stays restorable), updated from the
    // clusters' ObjectStores in this bucket (ledger-db archives elsewhere).
    let mut servers: BTreeMap<String, &Value> = BTreeMap::new();
    let mut order = vec![];
    for sv in l!(backup, "servers") {
        let n = s!(sv, "serverName").to_string();
        if !servers.contains_key(&n) {
            order.push(n.clone());
        }
        servers.insert(n, sv);
    }
    let servers_repr = repr(Some(&json!(servers)));
    if state == "empty" {
        let any_active = servers.values().any(|sv| eq(at!(sv, "active"), json!(true)));
        check(same_keys(&servers, &set(&["old-db", "orders-db"])) && !any_active,
            format!("before the bucket is known the last inventory stays, inactive: {servers_repr}"));
        return;
    }
    check(order == ["old-db", "orders-db", "orders-db-onprem-ams"], format!("servers {order:?}"));
    check(eq(servers.get("old-db").copied(), json!({"serverName": "old-db", "cluster": "old-db", "location": "si-ske-demo", "active": false,
        "postgresVersion": 16, "database": "app", "owner": "app", "firstRecoverabilityPoint": "2026-09-01T02:00:00Z",
        "lastSuccessfulBackup": "2026-09-30T02:00:00Z"})), format!("old-db {}", repr(servers.get("old-db").copied())));
    check(eq(servers.get("orders-db").copied(), json!({"serverName": "orders-db", "cluster": "orders-db", "location": "si-ske-demo", "active": true,
        "postgresVersion": 17, "database": "orders", "owner": "orders", "firstRecoverabilityPoint": "2026-10-02T02:00:00Z",
        "lastSuccessfulBackup": "2026-10-08T02:00:00Z"})), format!("orders-db {}", repr(servers.get("orders-db").copied())));
    let ams = v(servers.get("orders-db-onprem-ams").copied());
    check(s!(ams, "location") == "onprem-ams" && eq(at!(ams, "active"), json!(true)) && !has!(ams, "firstRecoverabilityPoint"), repr(Some(ams)));

    for (i, loc) in site_locs.iter().enumerate() {
        let sec = r.get(&format!("backup-s3-{loc}"));
        let mut data = Map::new();
        let mut decode_ok = true;
        for (k, val) in m!(sec, "data").into_iter().flatten() {
            let text = val.as_str().map(String::from).unwrap_or_else(|| function_basis::common::gojson::sprint(val));
            let raw = unb64(&text);
            decode_ok &= raw.is_some();
            data.insert(k.clone(), json!(raw.unwrap_or_default()));
        }
        let data_keys = keys(&data).join(" ");
        check(decode_ok && s!(sec, "kind") == "Secret" && s!(sec, "metadata", "namespace") == name
            && equal(&Value::Object(data), &json!({"ACCESS_KEY_ID": format!("FAKEKEYID{i}"), "ACCESS_SECRET_KEY": format!("fake-secret-{i}"), "REGION": "region-1"})),
            format!("{loc}: keys unpacked from COSI's BucketInfo: [{data_keys}]"));
        // The check, from the location itself, with that location's keys.
        let o = r.get(&format!("location-{loc}-backup-check-s3"));
        let want_refs: Vec<Value> = ["data", "type"].iter().map(|f| json!({"patchesFrom": {"apiVersion": "v1", "kind": "Secret",
            "name": format!("backup-s3-{loc}"), "namespace": name, "fieldPath": f}})).collect();
        check(s!(o, "spec", "providerConfigRef", "name") == loc && eq(at!(o, "spec", "references"), Value::Array(want_refs))
            && !has!(o, "spec", "forProvider", "manifest", "data")
            && !has!(o, "spec", "forProvider", "manifest", "metadata", "annotations", "platform.cndev.nl/copy-from"),
            format!("{loc}: backup-check-s3 must copy backup-s3-{loc} from the control plane: {}", repr(at!(o, "spec"))));
        let cj = v(at!(r.get(&format!("location-{loc}-backup-check")), "spec", "forProvider", "manifest"));
        let pod = v(at!(cj, "spec", "jobTemplate", "spec", "template", "spec"));
        let c = v(at!(pod, "containers", 0));
        let mut env = Map::new();
        for e in l!(c, "env") {
            let mut val = v(at!(e, "value")).clone();
            if val.as_str().is_none_or(str::is_empty) {
                val = v(at!(e, "valueFrom", "secretKeyRef", "name")).clone();
            }
            env.insert(s!(e, "name").into(), val);
        }
        check(s!(cj, "kind") == "CronJob" && s!(cj, "metadata", "namespace") == name && s!(cj, "spec", "concurrencyPolicy") == "Forbid"
            && equal(&Value::Object(env), &json!({"LOCATION": loc, "S3_ENDPOINT": "https://s3.example.com", "S3_BUCKET": format!("{name}-backups-0f3a"),
                "ACCESS_KEY_ID": "backup-check-s3", "ACCESS_SECRET_KEY": "backup-check-s3", "REGION": "backup-check-s3"}))
            && eq(at!(c, "securityContext", "readOnlyRootFilesystem"), json!(true))
            && eq(at!(pod, "securityContext", "runAsNonRoot"), json!(true))
            && is_int(v(at!(pod, "securityContext", "runAsUser"))),
            format!("{loc}: backup-check CronJob {}", repr(at!(cj, "spec"))));
    }
    // observe reports each CronJob's last run as successful.
    let want: Vec<Value> = site_locs.iter().map(|loc| json!({"location": loc, "state": "Reachable", "lastCheckTime": "2026-01-01T00:05:00Z",
        "lastSuccessTime": "2026-01-01T00:05:04Z"})).collect();
    check(eq(at!(backup, "reachability"), Value::Array(want)), format!("status.backup.reachability {}", repr(at!(backup, "reachability"))));
}
