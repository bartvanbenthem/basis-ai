use basis_tools::doc::{equal, keys, strs};
use basis_tools::{at, has, l, m, s};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::{Render, Set, all_strings, eq, list_str, prefixed, repr, same_keys, set, union, v};

/// One location's worth of objects with backups on, and the recovery site's
/// copy (prefix recovery-). Every member copies the S3 Secret to its location.
fn member() -> Set {
    set(&["cluster", "objectstore", "scheduled-backup", "podmonitor", "monitoring-queries", "prometheusrule", "secret-orders-db-s3"])
}

fn replicated() -> Set {
    union(&[&member(), &set(&["dashboard"]), &prefixed("recovery-", &member())])
}

fn bucket_site() -> Set {
    set(&["cluster", "objectstore", "scheduled-backup", "podmonitor", "monitoring-queries", "prometheusrule"])
}

fn expected(kase: &str) -> Option<Set> {
    let monitored = || set(&["cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard"]);
    Some(match kase {
        "bare" => set(&["cluster"]),
        "minimal" | "pinned" | "sized" | "sizegone" | "sizechanged" => monitored(),
        "noproject" | "bucketpending" | "restorepending" => set(&["dashboard"]),
        "production" => set(&["cluster", "objectstore", "scheduled-backup", "database-payments-audit", "pooler-rw", "pooler-ro",
            "podmonitor", "monitoring-queries", "podmonitor-pooler", "prometheusrule", "dashboard", "secret-payments-db-s3",
            "secret-payments-db-reporting"]),
        "secrets" => set(&["cluster", "objectstore", "scheduled-backup", "podmonitor", "monitoring-queries", "prometheusrule",
            "pooler-rw", "podmonitor-pooler", "dashboard", "secret-ledger-db-s3", "secret-ledger-db-reporting"]),
        "replicated" | "switchover" | "failover" | "promoted" | "draining" => replicated(),
        // The Project's COSI bucket: the same set per site, with its own credentials copy.
        "projectbucket" => union(&[&bucket_site(), &set(&["secret-secrets-db-backup-s3", "dashboard"]),
            &prefixed("recovery-", &union(&[&bucket_site(), &set(&["secret-secrets-db-backup-s3"])]))]),
        // Restored from the Project's bucket: the projectbucket set plus the
        // read-only restore store in the protected site.
        "restored" => union(&[&bucket_site(), &set(&["secret-secrets-db-r-backup-s3", "dashboard", "restore-objectstore"]),
            &prefixed("recovery-", &union(&[&bucket_site(), &set(&["secret-secrets-db-r-backup-s3"])]))]),
        // From a store of its own, without backups: no archive, only the restore store and its credentials.
        "restorecustom" => set(&["cluster", "restore-objectstore", "secret-ledger-db-s3", "podmonitor", "monitoring-queries", "prometheusrule"]),
        // An unknown size: nothing placed until it names one in the catalog.
        "sizeunknown" => set(&["dashboard"]),
        // The bootstrap database's extensions get a Database of their own.
        "extensions" => union(&[&monitored(), &set(&["database-docs", "database-analytics"])]),
        // ... unless databases[] lists that database.
        "extensionslisted" => union(&[&monitored(), &set(&["database-app"])]),
        "vector" => union(&[&monitored(), &set(&["database-docs"])]),
        _ => return None,
    })
}

/// The postgresql.conf settings the extensions in use bring from the
/// postgres-extensions catalog, under the size's and spec's.
fn extension_params(kase: &str) -> Value {
    match kase {
        "extensions" | "production" => json!({"pg_stat_statements.track": "top"}),
        _ => json!({}),
    }
}

const RECOVERY: &str = "onprem-ams";
const TOKEN: &str = "eyJsc24iOiIwLzMwMDAwMDAifQ==";
/// The recovery site's lastPromotionToken from an earlier promotion (observed/switchover.yaml).
const PREV_TOKEN: &str = "eyJsc24iOiIwLzIwMDAwMDAifQ==";

/// (size, resources, parameters, profile) per case: spec.size from the
/// postgres-sizes catalog (its resources and settings,
/// spec.postgresql.parameters on top), else spec.resources or the
/// defaults; status.sizing says what every site runs with.
fn sizing(kase: &str) -> (&'static str, Value, Value, &'static str) {
    let m = || json!({"requests": {"cpu": "2", "memory": "8Gi"}, "limits": {"memory": "8Gi"}});
    match kase {
        "sized" => ("m", m(), json!({"shared_buffers": "2GB", "effective_cache_size": "6GB", "work_mem": "16MB",
            "maintenance_work_mem": "512MB", "max_connections": "200"}), ""),
        // Kept from status.sizing: the catalog no longer has "retired".
        "sizegone" => ("retired", json!({"requests": {"cpu": "3", "memory": "12Gi"}, "limits": {"memory": "12Gi"}}),
            json!({"shared_buffers": "3GB"}), ""),
        // Not applied: the instances keep the size they had.
        "sizechanged" => ("m", m(), json!({"shared_buffers": "2GB"}), ""),
        "production" => ("", json!({"requests": {"cpu": "1", "memory": "4Gi"}, "limits": {"memory": "4Gi"}}), json!({}), ""),
        // Size m with its vector settings over its own.
        "vector" => ("m", m(), json!({"shared_buffers": "2GB", "effective_cache_size": "6GB", "work_mem": "16MB",
            "maintenance_work_mem": "1536MB", "max_parallel_maintenance_workers": "2", "max_connections": "200"}), "vector"),
        _ => ("", json!({"requests": {"cpu": "500m", "memory": "1Gi"}, "limits": {"memory": "1Gi"}}), json!({}), ""),
    }
}

fn obj<'a>(m: Option<&'a Map<String, Value>>) -> Box<dyn Iterator<Item = (&'a String, &'a Value)> + 'a> {
    match m {
        Some(m) => Box::new(m.iter()),
        None => Box::new(std::iter::empty()),
    }
}

pub fn assert(r: &mut Render, dashboard_src: &str) {
    let Some(expected) = expected(&r.kase) else {
        r.check(false, format!("no expectations for case {}", r.kase));
        return;
    };
    // Nothing observed yet: a new Cluster waits until the location reports
    // the ObjectStores its Barman Cloud plugin reads (the plugin stops the
    // Cluster's reconcile for good otherwise). The "stores" pass renders
    // again with them reported; it gets every other check, as nothing else
    // is observed there either.
    if r.state == "empty" {
        let mut withheld = Set::new();
        for prefix in ["", "recovery-"] {
            if r.composed.contains_key(&format!("{prefix}objectstore")) || r.composed.contains_key(&format!("{prefix}restore-objectstore")) {
                withheld.insert(format!("{prefix}cluster"));
            }
        }
        if !withheld.is_empty() {
            let rest: Set = expected.iter().filter(|k| !withheld.contains(*k)).cloned().collect();
            r.check(same_keys(&r.composed, &rest), format!("composed resources {} != expected {} (no Cluster before its ObjectStore)",
                list_str(&r.keys()), list_str(&rest)));
            return;
        }
    }
    if r.state == "stores" {
        r.state = "empty".into();
    }
    let r = &*r;
    let (kase, state, status, conds, name, ns, xr) = (r.kase.as_str(), r.state.as_str(), &r.status, &r.conds, r.name.as_str(), r.ns.as_str(), &r.xr);
    let check = |ok: bool, msg: String| r.check(ok, msg);
    let cond = |t: &str| v(conds.get(t));
    check(same_keys(&r.composed, &expected), format!("composed resources {} != expected {}", list_str(&r.keys()), list_str(&expected)));

    // --- sites: the protected location from the Project (or status.sites),
    // the recovery location for the recovery- objects. Nothing but the
    // dashboard runs on the control plane.
    let protected = if kase == "pinned" { "onprem-rtm" } else { "si-ske-demo" };
    let geo = ["replicated", "switchover", "failover", "promoted", "draining"].contains(&kase);
    for key in r.keys() {
        let o = r.get(&key);
        if key == "dashboard" {
            check(s!(o, "kind") == "GrafanaDashboard", "the dashboard is composed directly (Grafana runs on the control plane)".into());
            continue;
        }
        let loc = if key.starts_with("recovery-") { RECOVERY } else { protected };
        check(s!(o, "kind") == "Object", format!("{key}: objects for location {loc} must be wrapped in an Object"));
        if s!(o, "kind") != "Object" {
            continue;
        }
        check(eq(at!(o, "spec", "providerConfigRef"), json!({"kind": "ClusterProviderConfig", "name": loc})),
            format!("{key}: providerConfigRef {}", repr(at!(o, "spec", "providerConfigRef"))));
        check(s!(o, "metadata", "annotations", "platform.cndev.nl/location") == loc, format!("{key}: location annotation"));
        let manifest = v(at!(o, "spec", "forProvider", "manifest"));
        let leaked: Vec<&str> = m!(manifest, "metadata", "annotations").map(keys).unwrap_or_default().into_iter()
            .filter(|a| a.contains("crossplane") || a.starts_with("platform.cndev.nl/")).collect();
        check(leaked.is_empty(), format!("{key}: composition annotations leaked into the manifest: {leaked:?}"));
        check(s!(manifest, "metadata", "namespace") == ns, format!("{key}: manifest not in namespace {ns}"));
        if s!(manifest, "kind") == "Secret" {
            // Copied by reference: the value must never be in the Object spec.
            check(!has!(manifest, "data") && !has!(manifest, "stringData"), format!("{key}: Secret data in the Object spec"));
            let refs: Vec<&Value> = l!(o, "spec", "references").iter().map(|r| v(at!(r, "patchesFrom"))).collect();
            let mut paths: Vec<&str> = l!(o, "spec", "references").iter().map(|r| s!(r, "patchesFrom", "fieldPath")).collect();
            paths.sort();
            let refs_repr = repr(Some(&Value::Array(refs.iter().map(|r| (*r).clone()).collect())));
            check(paths == ["data", "type"], format!("{key}: Secret must be patched by reference: {refs_repr}"));
            // The Project bucket's credentials come from backup-s3-<location>
            // (checked below); the rest from the same name here.
            if !key.ends_with("-backup-s3") {
                let all = refs.iter().all(|r| s!(r, "kind") == "Secret" && s!(r, "name") == s!(manifest, "metadata", "name") && s!(r, "namespace") == ns);
                check(all, format!("{key}: Secret must be patched from {ns}/{}: {refs_repr}", s!(manifest, "metadata", "name")));
            }
        }
    }

    match kase {
        "noproject" => {
            check(eq(at!(status, "locations"), json!([])) && !has!(status, "sites") && !has!(status, "primaryLocation"),
                format!("no sites without a Project: {}", repr(Some(status))));
            check(s!(status, "message").contains("not a Project with a protected location"), format!("message {}", repr(at!(status, "message"))));
            check(s!(cond("PostgresReady"), "reason") == "NoSite", "PostgresReady reason NoSite".into());
        }
        "sizeunknown" => {
            check(eq(at!(status, "locations"), json!([])) && !has!(status, "sizing"), format!("nothing placed yet: {}", repr(Some(status))));
            check(s!(status, "message").contains("size huge is not in the postgres-sizes catalog"), format!("message {}", repr(at!(status, "message"))));
        }
        "bucketpending" | "restorepending" => {
            check(eq(at!(status, "locations"), json!([])) && !has!(status, "backupStore"), format!("nothing placed yet: {}", repr(Some(status))));
            let verb = if kase == "restorepending" { "restore reads from" } else { "backup uses" };
            check(s!(status, "message").contains(&format!("{verb} the backup bucket of Project vault, which isn't ready")),
                format!("message {}", repr(at!(status, "message"))));
        }
        _ => {
            // The Projects in payments (required/default.yaml) and vault (projectbucket) have a recovery site.
            let mut want = json!({"protected": protected});
            if ns == "payments" || kase == "projectbucket" || kase == "restored" {
                want["recovery"] = json!(RECOVERY);
            }
            check(eq(at!(status, "sites"), want.clone()), format!("status.sites {} != {}", repr(at!(status, "sites")), repr(Some(&want))));
        }
    }

    // --- backups in the Project's COSI bucket: one bucket, credentials per site from the Project's Secrets
    if kase == "projectbucket" || kase == "restored" {
        let store = json!({"destinationPath": "s3://vault-backups-0f3a/barman", "endpointURL": "https://s3.example.com",
            "namespace": "vault", "region": true});
        check(eq(at!(status, "backupStore"), store.clone()), format!("status.backupStore {}", repr(at!(status, "backupStore"))));
        for (prefix, loc) in [("", protected), ("recovery-", RECOVERY)] {
            let cfg = v(at!(r.live(&format!("{prefix}objectstore")), "spec", "configuration"));
            check(s!(cfg, "destinationPath") == s!(&store, "destinationPath") && s!(cfg, "endpointURL") == s!(&store, "endpointURL"),
                format!("{loc}: ObjectStore not in the project bucket: {}", repr(Some(cfg))));
            let creds = v(at!(cfg, "s3Credentials"));
            let same_secret = ["accessKeyId", "secretAccessKey", "region"].iter().all(|k| s!(creds, *k, "name") == format!("{name}-backup-s3"));
            check(same_secret && s!(creds, "accessKeyId", "key") == "ACCESS_KEY_ID" && s!(creds, "secretAccessKey", "key") == "ACCESS_SECRET_KEY"
                && s!(creds, "region", "key") == "REGION", format!("{loc}: s3Credentials {}", repr(Some(creds))));
            let secret = r.get(&format!("{prefix}secret-{name}-backup-s3"));
            let refs: Vec<Value> = l!(secret, "spec", "references").iter().map(|r| v(at!(r, "patchesFrom")).clone()).collect();
            let all = refs.iter().all(|p| s!(p, "namespace") == "vault" && s!(p, "name") == format!("backup-s3-{loc}"));
            check(all, format!("{loc}: credentials must come from vault/backup-s3-{loc}: {}", repr(Some(&Value::Array(refs.clone())))));
        }
        if kase == "projectbucket" {
            check(s!(r.live("objectstore"), "spec", "retentionPolicy") == "14d", "the cluster's own backup settings stay".into());
            let ext: Set = l!(r.live("recovery-cluster"), "spec", "externalClusters").iter().map(|e| s!(e, "name").to_string()).collect();
            check(ext == set(&["secrets-db", "secrets-db-onprem-ams"]), format!("externalClusters {}", list_str(&ext)));
        }
    } else {
        check(!has!(status, "backupStore"), "backupStore only for clusters on the Project's bucket".into());
    }

    // --- distributed topology
    if geo {
        let main = v(at!(r.live("cluster"), "spec"));
        let replica = v(at!(r.live("recovery-cluster"), "spec"));
        for spec in [main, replica] {
            let ext: BTreeMap<String, Value> = l!(spec, "externalClusters").iter()
                .map(|e| (s!(e, "name").to_string(), v(at!(e, "plugin", "parameters")).clone())).collect();
            let ok = same_keys(&ext, &set(&["orders-db", "orders-db-onprem-ams"]))
                && ext.iter().all(|(n, p)| s!(p, "serverName") == n && s!(p, "barmanObjectName") == "orders-db-backup");
            check(ok, format!("externalClusters {}", repr(Some(&json!(ext)))));
        }
        check(s!(main, "replica", "self") == "orders-db" && s!(replica, "replica", "self") == "orders-db-onprem-ams",
            "replica.self must be the member's topology name".into());
        check(has!(main, "initdb", "bootstrap") && eq(at!(replica, "bootstrap"), json!({"recovery": {"source": "orders-db"}})),
            "the protected site runs initdb, the replica cluster recovers from it".into());
        check(!has!(main, "serverName", "plugins", 0, "parameters"), "the protected site keeps its archive folder".into());
        check(s!(replica, "plugins", 0, "parameters", "serverName") == "orders-db-onprem-ams", "the replica cluster archives to its own folder".into());
        check(s!(r.live("recovery-cluster"), "metadata", "name") == "orders-db",
            "every member's Cluster is named after the XR (stable service/secret names)".into());
        if kase == "replicated" {
            check(eq(at!(replica, "instances"), json!(2)), "geoReplication.instances".into());
        }
        // Who is primary, per case and state: (main.primary, replica.primary, token on the promoted member, status)
        let want = |k: &str| -> Option<Value> {
            Some(match k {
                "replicated" => json!(["orders-db", "orders-db", null, protected]),
                "switchover/empty" => json!(["orders-db-onprem-ams", "orders-db", null, protected]),
                "switchover/observed" => json!(["orders-db-onprem-ams", "orders-db-onprem-ams", TOKEN, RECOVERY]),
                "failover" => json!(["orders-db-onprem-ams", "orders-db-onprem-ams", null, RECOVERY]),
                "promoted" => json!(["orders-db-onprem-ams", "orders-db-onprem-ams", TOKEN, RECOVERY]),
                // Draining: switching back to the protected site, waiting for onprem-ams' demotion token.
                "draining" => json!(["orders-db-onprem-ams", "orders-db", null, RECOVERY]),
                _ => return None,
            })
        };
        let ks = format!("{kase}/{state}");
        let exp = want(&ks).or_else(|| want(kase)).unwrap_or(Value::Null);
        let got = json!([v(at!(main, "replica", "primary")), v(at!(replica, "replica", "primary")),
            v(at!(replica, "replica", "promotionToken")), v(at!(status, "primaryLocation"))]);
        check(equal(&got, &exp), format!("(protected primary, recovery primary, token, status.primaryLocation) {} != {}", repr(Some(&got)), repr(Some(&exp))));
        check(!has!(main, "promotionToken", "replica"), "the protected site was never promoted here".into());
        if kase != "draining" {
            check(eq(at!(status, "promotionToken"), exp[2].clone()), format!("status.promotionToken {}", repr(at!(status, "promotionToken"))));
        }
        let primary_site = if exp[3] == RECOVERY { "recovery" } else { "protected" };
        check(s!(status, "primarySite") == primary_site, format!("status.primarySite {}", repr(at!(status, "primarySite"))));
        let (mut sites, mut roles) = (Map::new(), Map::new());
        for l in l!(status, "locations") {
            sites.insert(s!(l, "location").into(), v(at!(l, "site")).clone());
            roles.insert(s!(l, "location").into(), v(at!(l, "role")).clone());
        }
        let (sites, roles) = (Value::Object(sites), Value::Object(roles));
        check(equal(&sites, &json!({protected: "protected", RECOVERY: "recovery"})), format!("sites {}", repr(Some(&sites))));
        if ks == "switchover/empty" {
            check(equal(&roles, &json!({protected: "primary", RECOVERY: "promoting"})), format!("roles {}", repr(Some(&roles))));
            check(s!(status, "message").contains("waiting for the demotion token"), format!("message {}", repr(at!(status, "message"))));
        } else if kase == "draining" {
            check(equal(&roles, &json!({protected: "promoting", RECOVERY: "primary"})), format!("roles {}", repr(Some(&roles))));
        } else {
            let primary = exp[3].as_str().unwrap_or("");
            let other = if primary == protected { RECOVERY } else { protected };
            check(equal(&roles, &json!({primary: "primary", other: "replica"})), format!("roles {}", repr(Some(&roles))));
        }
        // CNPG reload workaround: a member that recorded a promotion carries
        // a placeholder GUC derived from it, so its instances reload their config.
        let marker = if ks == "switchover/observed" {
            json!([null, hex::encode(Sha256::digest(PREV_TOKEN.as_bytes()))[..16]])
        } else {
            json!([null, null])
        };
        let got = json!([v(at!(main, "postgresql", "parameters", "basis.last_promotion")),
            v(at!(replica, "postgresql", "parameters", "basis.last_promotion"))]);
        check(equal(&got, &marker), format!("basis.last_promotion {}", repr(Some(&got))));
    } else if !["noproject", "bucketpending", "projectbucket", "restored", "restorepending", "sizeunknown"].contains(&kase) {
        let spec = v(at!(r.live("cluster"), "spec"));
        let ext: Vec<&str> = l!(spec, "externalClusters").iter().map(|e| s!(e, "name")).collect();
        let want_ext: Vec<&str> = if has!(xr, "restore", "spec") { vec!["restore-source"] } else { vec![] };
        check(!has!(spec, "replica") && ext == want_ext, format!("a single-site cluster has no replica topology: externalClusters {ext:?}"));
        check(s!(status, "primaryLocation") == protected, format!("status.primaryLocation {}", repr(at!(status, "primaryLocation"))));
        check(s!(status, "primarySite") == "protected", format!("status.primarySite {}", repr(at!(status, "primarySite"))));
        let locs: Vec<Value> = l!(status, "locations").iter().map(|l| json!([v(at!(l, "location")), v(at!(l, "site"))])).collect();
        check(equal(&Value::Array(locs), &json!([[protected, "protected"]])), "status.locations".into());
    }

    for key in r.keys() {
        let o = r.get(&key);
        check(s!(o, "metadata", "namespace") == ns, format!("{key}: not in XR namespace {ns}"));
        check(s!(o, "metadata", "labels", "postgres.cndev.nl/postgrescluster") == name, format!("{key}: missing postgres.cndev.nl/postgrescluster label"));
    }

    // --- readiness / status
    if state == "empty" || ["noproject", "bucketpending", "restorepending", "sizeunknown", "sizechanged"].contains(&kase) {
        check(eq(at!(status, "ready"), json!(false)), "status.ready should be false before the Cluster exists".into());
        check(s!(cond("PostgresReady"), "status") == "False", "PostgresReady should be False".into());
        if kase != "sizechanged" {
            // its composed resources are all there
            check(s!(cond("Ready"), "status") == "False", "XR Ready should be False".into());
        }
    } else {
        check(eq(at!(status, "ready"), json!(true)), format!("status.ready should be true, got {}", repr(at!(status, "ready"))));
        let want_ready = v(at!(r.live("cluster"), "spec", "instances"));
        check(eq(at!(status, "readyInstances"), want_ready.clone()), format!("readyInstances should be {}", repr(Some(want_ready))));
        check(s!(status, "currentPrimary") == format!("{name}-1"), "currentPrimary not mirrored".into());
        check(s!(cond("PostgresReady"), "status") == "True", "PostgresReady should be True".into());
        check(s!(cond("Ready"), "status") == "True", format!("XR Ready should be True, got {}", repr(conds.get("Ready"))));
        if kase == "production" {
            check(s!(status, "backup", "lastSuccessfulBackup") == "2026-10-07T02:00:41Z", "backup.lastSuccessfulBackup not mirrored from ObjectStore".into());
        }
    }

    // --- sizing
    if kase != "sizeunknown" {
        let (size, resources, params, profile) = sizing(kase);
        let mut want = json!({"size": size, "resources": resources, "parameters": params});
        if !profile.is_empty() {
            want["profile"] = json!(profile);
        }
        check(eq(at!(status, "sizing"), want.clone()), format!("status.sizing {} != {}", repr(at!(status, "sizing")), repr(Some(&want))));
        for key in ["cluster", "recovery-cluster"] {
            if !r.composed.contains_key(key) {
                continue;
            }
            let spec = v(at!(r.live(key), "spec"));
            check(eq(at!(spec, "resources"), resources.clone()), format!("{key}: resources {} != {}", repr(at!(spec, "resources")), repr(Some(&resources))));
            // basis.last_promotion is the CNPG reload workaround, checked with the topology.
            let got: Map<String, Value> = obj(m!(spec, "postgresql", "parameters")).filter(|(k, _)| *k != "basis.last_promotion")
                .map(|(k, v)| (k.clone(), v.clone())).collect();
            let mut merged = Map::new();
            for src in [extension_params(kase), params.clone(), v(at!(xr, "spec", "postgresql", "parameters")).clone()] {
                for (k, v) in obj(src.as_object()) {
                    merged.insert(k.clone(), v.clone());
                }
            }
            let (got, merged) = (Value::Object(got), Value::Object(merged));
            check(equal(&got, &merged), format!("{key}: parameters {} != extensions' under size's under spec's {}", repr(Some(&got)), repr(Some(&merged))));
        }
    }
    // --- extensions: one CNPG Database per database, the bootstrap one never dropped.
    let want_dbs: Vec<(&str, Value)> = match kase {
        "extensions" => vec![
            ("database-docs", json!({"name": "docs", "owner": "docs", "reclaim": "retain", "extensions": ["vector", "pg_trgm"]})),
            ("database-analytics", json!({"name": "analytics", "owner": "docs", "reclaim": "retain", "extensions": ["pg_stat_statements"]})),
        ],
        "extensionslisted" => vec![("database-app", json!({"name": "app", "owner": "app", "reclaim": "retain", "extensions": ["pg_trgm"]}))],
        // What they require (vector) first, although the spec leaves it out.
        "vector" => vec![("database-docs", json!({"name": "docs", "owner": "docs", "reclaim": "retain", "extensions": ["vector", "vchord", "pg_search"]}))],
        _ => vec![],
    };
    for (key, want) in want_dbs {
        let spec = v(at!(r.live(key), "spec"));
        let mut exts = vec![];
        for e in l!(spec, "extensions") {
            check(s!(e, "ensure") == "present", format!("{key}: extension {} not ensured present", s!(e, "name")));
            exts.push(json!(s!(e, "name")));
        }
        let got = json!({"name": s!(spec, "name"), "owner": s!(spec, "owner"), "reclaim": s!(spec, "databaseReclaimPolicy"),
            "extensions": if exts.is_empty() { Value::Null } else { Value::Array(exts) }});
        check(equal(&got, &want), format!("{key}: {} != {}", repr(Some(&got)), repr(Some(&want))));
        check(s!(spec, "cluster", "name") == name, format!("{key}: cluster.name"));
    }

    // --- image extensions: mounted from the catalog's images and preloaded.
    if kase == "vector" {
        let pg = v(at!(r.live("cluster"), "spec", "postgresql"));
        let mut mounted = vec![];
        for e in l!(pg, "extensions") {
            mounted.push(json!(s!(e, "name")));
            check(s!(e, "image", "reference").contains("@sha256:"), format!("extension {} image not pinned by digest", s!(e, "name")));
        }
        let mounted = Value::Array(mounted);
        check(equal(&mounted, &json!(["vchord", "pg_search"])), format!("image extensions {}", repr(Some(&mounted))));
        check(eq(at!(pg, "shared_preload_libraries"), json!(["vchord", "pg_search"])),
            format!("shared_preload_libraries {}", repr(at!(pg, "shared_preload_libraries"))));
        check(eq(at!(r.live("cluster"), "spec", "imageCatalogRef", "major"), json!(18.0)), "imageCatalogRef.major should be 18".into());
        let queries = s!(r.live("monitoring-queries"), "data", "queries");
        check(queries.contains("vector_index:") && queries.contains("create_index_progress:"), "vector exporter queries missing".into());
    }

    if kase == "sizechanged" {
        check(s!(status, "message").contains("size huge is not in the postgres-sizes catalog; the instances keep running as m"),
            format!("message {}", repr(at!(status, "message"))));
    }
    if kase == "sizegone" {
        check(!s!(status, "message").contains("catalog"), format!("a retired size is no problem: {}", repr(at!(status, "message"))));
    }

    // --- backup folders: the cluster's name, a folder of its own per
    // replica cluster. The Project keeps an inventory of them through the
    // label on the ObjectStore's Object.
    for key in r.keys() {
        if key.ends_with("objectstore") && !key.ends_with("restore-objectstore") {
            let manifest = r.live(&key);
            let folder = at!(manifest, "metadata", "annotations", "postgres.cndev.nl/server-name");
            let params = v(at!(r.live(&key.replacen("objectstore", "cluster", 1)), "spec", "plugins", 0, "parameters"));
            let archived = at!(params, "serverName").cloned().unwrap_or_else(|| json!(name));
            check(eq(folder, archived), format!("{key}: server-name annotation {} != the folder archived to", repr(folder)));
            check(s!(r.get(&key), "metadata", "labels", "postgres.cndev.nl/backup-store") == "true",
                format!("{key}: the Project finds backup folders by the postgres.cndev.nl/backup-store label"));
            let version = at!(xr, "spec", "postgresVersion").map(function_basis::common::gojson::sprint).unwrap_or_else(|| "17".into());
            check(s!(manifest, "metadata", "annotations", "postgres.cndev.nl/postgres-version") == version, format!("{key}: postgres-version annotation"));
        } else if key.contains("objectstore") {
            check(!has!(r.get(&key), "postgres.cndev.nl/backup-store", "metadata", "labels"),
                format!("{key}: a restore source is not one of this cluster's backup folders"));
        }
    }
    if r.composed.contains_key("objectstore") && !l!(status, "locations").is_empty() {
        let primary = l!(status, "locations").iter().find(|l| s!(l, "role") == "primary").map(|l| s!(l, "location")).unwrap_or("");
        let key = if primary == protected { "objectstore" } else { "recovery-objectstore" };
        check(eq(at!(status, "backup", "serverName"), v(at!(r.live(key), "metadata", "annotations", "postgres.cndev.nl/server-name")).clone()),
            format!("status.backup.serverName {} is the primary's folder", repr(at!(status, "backup"))));
    }

    // --- restore: the protected site bootstraps from the source folder
    // through a read-only store, and archives to a folder of its own.
    if kase == "restored" || kase == "restorecustom" {
        let restore = v(at!(xr, "spec", "restore"));
        let uid = s!(xr, "metadata", "uid");
        let own = format!("{name}-{}", &uid[..uid.len().min(8)]);
        let spec = v(at!(r.live("cluster"), "spec"));
        let database = if has!(xr, "name", "spec", "database") { s!(xr, "spec", "database", "name") } else { "app" };
        let owner = if has!(xr, "owner", "spec", "database") { s!(xr, "spec", "database", "owner") } else { "app" };
        let mut want = json!({"source": "restore-source", "database": database, "owner": owner});
        if has!(restore, "targetTime") {
            want["recoveryTarget"] = json!({"targetTime": restore["targetTime"]});
        }
        check(eq(at!(spec, "bootstrap"), json!({"recovery": want})), format!("bootstrap {} != {}", repr(at!(spec, "bootstrap")), repr(Some(&want))));
        let ext: BTreeMap<String, Value> = l!(spec, "externalClusters").iter()
            .map(|e| (s!(e, "name").to_string(), v(at!(e, "plugin", "parameters")).clone())).collect();
        check(eq(ext.get("restore-source"), json!({"barmanObjectName": format!("{name}-restore"), "serverName": v(at!(restore, "source", "serverName"))})),
            format!("restore-source externalCluster {}", repr(ext.get("restore-source"))));
        let store = v(at!(r.live("restore-objectstore"), "spec"));
        check(!has!(store, "retentionPolicy"), "the restore store must never prune the source's backups".into());
        if kase == "restored" {
            check(s!(status, "backup", "serverName") == own, format!("status.backup.serverName {} != {own}", repr(at!(status, "backup"))));
            check(s!(spec, "plugins", 0, "parameters", "serverName") == own, "a restored cluster archives to a folder of its own".into());
            let ext_keys: Set = ext.keys().cloned().collect();
            check(same_keys(&ext, &set(&[&own, &format!("{own}-{RECOVERY}"), "restore-source"])), format!("externalClusters {}", list_str(&ext_keys)));
            check(s!(spec, "replica", "self") == own && own == s!(spec, "replica", "primary"), format!("replica {}", repr(at!(spec, "replica"))));
            let replica = v(at!(r.live("recovery-cluster"), "spec"));
            check(eq(at!(replica, "bootstrap"), json!({"recovery": {"source": own}})),
                format!("the replica cluster starts from {own}: {}", repr(at!(replica, "bootstrap"))));
            check(s!(replica, "plugins", 0, "parameters", "serverName") == format!("{own}-{RECOVERY}"), "replica cluster folder".into());
            check(!r.composed.contains_key("recovery-restore-objectstore"), "only the protected site restores".into());
            check(s!(store, "configuration", "destinationPath") == "s3://vault-backups-0f3a/barman"
                && s!(store, "configuration", "s3Credentials", "accessKeyId", "name") == format!("{name}-backup-s3"),
                format!("restore store not on the Project's bucket: {}", repr(Some(store))));
            if state == "empty" {
                check(s!(status, "message").starts_with(&format!("Restoring {name} from backup folder secrets-db (up to 2026-10-08T09:30:00Z)")),
                    format!("message {}", repr(at!(status, "message"))));
            }
        } else {
            check(!has!(spec, "plugins") && !has!(spec, "replica"), "no backups, no topology: nothing to archive".into());
            let ext_keys: Set = ext.keys().cloned().collect();
            check(same_keys(&ext, &set(&["restore-source"])), format!("externalClusters {}", list_str(&ext_keys)));
            let cfg = v(at!(store, "configuration"));
            check(eq(at!(cfg, "destinationPath"), v(at!(restore, "source", "destinationPath")).clone())
                && eq(at!(cfg, "endpointURL"), v(at!(restore, "source", "endpointURL")).clone())
                && eq(at!(cfg, "s3Credentials", "secretAccessKey"), json!({"name": "ledger-db-s3", "key": "ACCESS_SECRET_KEY"})),
                format!("restore store {}", repr(Some(cfg))));
            check(!has!(status, "backupStore") && !has!(status, "backup"), format!("no backups: {}", repr(Some(status))));
            if state == "empty" {
                check(s!(status, "message").contains("from backup folder ledger-db (latest state)"), format!("message {}", repr(at!(status, "message"))));
            }
        }
    }

    check(s!(status, "endpoints", "readWrite") == format!("{name}-rw.{ns}.svc"), "endpoints.readWrite".into());
    check(s!(status, "secrets", "app") == format!("{name}-app"), "secrets.app".into());

    if kase == "bare" {
        let spec = v(at!(r.live("cluster"), "spec"));
        check(!has!(spec, "postgresql"), "empty postgresql block must be omitted".into());
        check(!has!(spec, "topologySpreadConstraints"), "zoneSpread: false must drop the zone constraint".into());
        check(eq(at!(spec, "enableSuperuserAccess"), json!(true)), "enableSuperuserAccess not passed through".into());
        check(s!(status, "secrets", "superuser") == format!("{name}-superuser"), "secrets.superuser".into());
        check(!has!(status, "monitoring"), "no dashboard uid without a dashboard".into());
    }

    // --- dashboard
    if let Some(dash) = r.composed.get("dashboard") {
        assert_dashboard(r, dash, dashboard_src);
    }

    // --- external access: <name>-external only with expose.enabled (internal by default)
    if r.composed.contains_key("cluster") {
        let exposed = eq(at!(xr, "spec", "expose", "enabled"), json!(true));
        let external = l!(r.live("cluster"), "spec", "managed", "services", "additional").iter().rfind(|svc| s!(svc, "serviceTemplate", "metadata", "name") == format!("{name}-external"));
        check(external.is_some() == exposed, format!("expose.enabled {exposed} but external Service present: {}", external.is_some()));
        if let Some(external) = external {
            check(s!(external, "selectorType") == "rw" && s!(external, "serviceTemplate", "spec", "type") == "LoadBalancer",
                format!("external Service {}", repr(Some(external))));
            check(!l!(external, "serviceTemplate", "spec", "loadBalancerSourceRanges").is_empty(), "external Service without source ranges".into());
        }
    }

    // --- custom exporter queries: the Cluster reads them from the ConfigMap next to it
    if r.composed.contains_key("monitoring-queries") {
        let cm = r.live("monitoring-queries");
        let refs = l!(r.live("cluster"), "spec", "monitoring", "customQueriesConfigMap");
        check(refs.len() == 1 && s!(&refs[0], "name") == s!(cm, "metadata", "name") && s!(&refs[0], "key") == "queries",
            format!("Cluster spec.monitoring.customQueriesConfigMap should name ConfigMap {}, got {}", s!(cm, "metadata", "name"),
                repr(Some(&Value::Array(refs.to_vec())))));
        check(s!(cm, "data", "queries").contains("wal_archive:"), "monitoring ConfigMap without the wal_archive query".into());
    }

    // --- alerts
    if r.composed.contains_key("prometheusrule") {
        let rules = l!(r.live("prometheusrule"), "spec", "groups", 0, "rules");
        let mut alerts = vec![];
        for rule in rules {
            check(!s!(rule, "alert").is_empty(), format!("alert rule without a name: {}", repr(Some(rule))));
            alerts.push(s!(rule, "alert").to_string());
        }
        let excluded = strs(at!(xr, "spec", "monitoring", "prometheusRule", "excludeRules"));
        let want = 21 - excluded.len();
        check(alerts.len() == want, format!("expected {want} alert rules, got {}", alerts.len()));
        check(!alerts.iter().any(|a| excluded.contains(a)), "excluded rules still present".into());
        let text = all_strings(&Value::Array(rules.to_vec()));
        check(!text.contains("zz"), "unsubstituted placeholder in alert rules".into());
        check(text.contains("{{ $labels.pod }}") || text.contains("{{ $value }}"), "Prometheus templating not preserved".into());
        check(text.contains(&format!("namespace={}", function_basis::common::gojson::quote(ns))), "alert expressions not scoped to the namespace".into());
    }
}

fn assert_dashboard(r: &Render, dash: &Value, source_path: &str) {
    let (status, name, ns) = (&r.status, r.name.as_str(), r.ns.as_str());
    let model: Value = match serde_json::from_str(s!(dash, "spec", "json")) {
        Ok(m) => m,
        Err(e) => {
            r.check(false, format!("dashboard spec.json is not JSON: {e}"));
            return;
        }
    };
    let source: Value = match std::fs::read_to_string(source_path).map_err(|e| e.to_string())
        .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
    {
        Ok(s) => s,
        Err(e) => {
            r.check(false, format!("dashboard source {source_path}: {e}"));
            return;
        }
    };
    let uid = s!(dash, "spec", "uid");
    r.check(s!(&model, "uid") == uid && uid == s!(status, "monitoring", "dashboardUid"), "dashboard uid mismatch");
    r.check(uid.len() <= 40, "Grafana uids are limited to 40 chars");
    r.check(s!(&model, "title") == format!("CloudNativePG / {ns} / {name}"),
        format!("dashboard title {}", function_basis::common::gojson::quote(s!(&model, "title"))));
    r.check(l!(&model, "panels").len() == l!(&source, "panels").len(), "dashboard panels differ from source JSON");
    let current: BTreeMap<&str, &Value> = l!(&model, "templating", "list").iter()
        .map(|t| (s!(t, "name"), v(at!(t, "current", "value")))).collect();
    r.check(eq(current.get("namespace").copied(), json!(ns)) && eq(current.get("cluster").copied(), json!(name)), "dashboard variables not preset");
    // Grafana legend templates like {{pod}} must survive the composition verbatim.
    let (m, src) = (serde_json::to_string(&model).unwrap_or_default(), serde_json::to_string(&source).unwrap_or_default());
    r.check(m.matches("{{").count() == src.matches("{{").count(), "dashboard {{ }} legend formats altered");
}
