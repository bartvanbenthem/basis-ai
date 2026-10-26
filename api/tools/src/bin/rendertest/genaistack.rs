use basis_tools::{at, has, l, m, s};
use serde_json::json;
use std::collections::BTreeMap;

use crate::{Render, eq, repr, unb64};

pub fn assert(r: &Render) {
    let (kase, state, status, name, ns) = (r.kase.as_str(), r.state.as_str(), &r.status, r.name.as_str(), r.ns.as_str());
    let check = |ok: bool, msg: String| r.check(ok, msg);
    let geo = kase == "geo";

    let location = |s: &str| if s == "recovery" { "onprem-ams" } else { "si-ske-demo" };
    let sites = if geo { vec!["protected", "recovery"] } else { vec!["protected"] };
    // xr/geo.yaml switches over; the stack follows once the database has
    // moved (observed/geo.yaml).
    let active = if geo && state == "observed" { "recovery" } else { "protected" };
    check(s!(status, "activeSite") == active, format!("activeSite {:?}, want {active:?}", s!(status, "activeSite")));

    // --- the child APIs next to the stack
    let db = r.get("database");
    check(s!(db, "kind") == "PostgresCluster" && s!(db, "metadata", "name") == format!("{name}-db") && s!(db, "metadata", "namespace") == ns,
        format!("database: PostgresCluster {name}-db"));
    check(s!(db, "spec", "profile") == "vector" && eq(at!(db, "spec", "postgresVersion"), json!(18)), "database: vector profile on PostgreSQL 18".into());
    check(eq(at!(db, "spec", "geoReplication", "enabled"), json!(geo)) && eq(at!(db, "spec", "backup", "enabled"), json!(geo)),
        format!("database: geoReplication and backup {geo}"));
    let want_primary = if geo { "recovery" } else { "protected" };
    check(s!(db, "spec", "geoReplication", "primarySite") == want_primary,
        format!("database: primarySite {:?}, want {want_primary:?} (the stack's activeSite)", s!(db, "spec", "geoReplication", "primarySite")));
    let roles = l!(db, "spec", "roles");
    let role = format!("{}_stack", name.replace('-', "_"));
    check(roles.len() == 1 && s!(&roles[0], "name") == role && s!(&roles[0], "passwordSecret") == format!("{name}-db-credentials")
        && eq(at!(&roles[0], "inRoles"), json!(["app"])), format!("database roles {}", repr(at!(db, "spec", "roles"))));
    check(s!(r.get("db-credentials"), "type") == "kubernetes.io/basic-auth", "db-credentials must be basic-auth (CNPG managed roles)".into());

    for s in &sites {
        let cache = if *s == "recovery" { "cache-dr" } else { "cache" };
        let c = r.get(cache);
        check(s!(c, "kind") == "ValkeyCache" && s!(c, "spec", "site") == *s, format!("{cache}: ValkeyCache on site {s}"));
        check(eq(at!(c, "spec", "shards"), json!(1)) && eq(at!(c, "spec", "replicas"), json!(0)), format!("{cache}: one node, so plain clients work"));
        let want = if *s == active { "1Gi" } else { "512Mi" };
        check(s!(c, "spec", "resources", "memory") == want,
            format!("{cache}: memory {:?}, want {want:?} (active {active})", s!(c, "spec", "resources", "memory")));
    }

    // --- the stack's own gateway, a ModelGateway following the active site
    let gw = r.get("gateway");
    check(s!(gw, "kind") == "ModelGateway" && s!(gw, "metadata", "name") == format!("{name}-gateway"), format!("gateway: ModelGateway {name}-gateway"));
    check(s!(gw, "spec", "activeSite") == active && eq(at!(gw, "spec", "recovery", "enabled"), json!(geo)),
        format!("gateway: activeSite {:?} recovery {}", s!(gw, "spec", "activeSite"), repr(at!(gw, "spec", "recovery", "enabled"))));
    check(eq(at!(gw, "spec", "clients"), json!([{"name": "apps"}])), "gateway: the stack's client".into());
    let want_models = if geo { 1 } else { 2 };
    check(l!(gw, "spec", "models").len() == want_models, format!("gateway: models {}", repr(at!(gw, "spec", "models"))));
    if geo {
        check(eq(at!(db, "spec", "expose"), json!({"enabled": true, "loadBalancerSourceRanges": ["203.0.113.10/32"]})),
            format!("database: retrieval.expose passed on: {}", repr(at!(db, "spec", "expose"))));
        check(s!(gw, "spec", "expose", "hostname") == "bot.example.com" && s!(gw, "spec", "expose", "issuer") == "basis",
            format!("gateway: gateway.expose passed on: {}", repr(at!(gw, "spec", "expose"))));
    } else {
        check(!has!(db, "spec", "expose") && !has!(gw, "spec", "expose"), "nothing exposed without spec.*.expose".into());
    }

    // --- what the stack composes is the stack's (the ownership policy reads this label)
    for key in ["database", "cache", "gateway"] {
        check(s!(r.get(key), "metadata", "labels", "ai.cndev.nl/genaistack") == name, format!("{key}: owner label"));
    }

    // --- per site: wiring in the location
    for s in &sites {
        let conn = r.get(&format!("connection-{s}"));
        let data: BTreeMap<&str, String> = m!(conn, "data").into_iter().flatten()
            .map(|(k, val)| (k.as_str(), unb64(val.as_str().unwrap_or("")).unwrap_or_default())).collect();
        let d = |k: &str| data.get(k).map(String::as_str).unwrap_or("");
        let cache_host = if *s == "recovery" { format!("valkey-{name}-cache-dr") } else { format!("valkey-{name}-cache") };
        let is_active = if *s == active { "true" } else { "false" };
        check(d("SITE") == *s && d("ACTIVE") == is_active, format!("connection-{s}: SITE/ACTIVE {data:?}"));
        check(d("DATABASE_URL").starts_with(&format!("postgresql://{role}:")) && d("DATABASE_URL").ends_with(&format!("@{name}-db-rw.{ns}.svc:5432/app")),
            format!("connection-{s}: DATABASE_URL {:?}", d("DATABASE_URL")));
        check(d("VALKEY_URL").contains(&format!("@{cache_host}.{ns}.svc:6379")) && d("VALKEY_CLUSTER") == "false",
            format!("connection-{s}: VALKEY_URL {:?}", d("VALKEY_URL")));
        check(d("OPENAI_BASE_URL") == format!("http://{name}-gateway.{ns}.svc/v1") && d("OPENAI_API_KEY") == "gateway-key",
            format!("connection-{s}: gateway {data:?}"));
        if state == "observed" {
            check(d("DATABASE_PASSWORD") == "db-password", format!("connection-{s}: generated credentials must be kept"));
        }

        for (key, o) in &r.composed {
            if !key.starts_with(&format!("{s}-")) {
                continue;
            }
            check(s!(o, "kind") == "Object" && eq(at!(o, "spec", "providerConfigRef"), json!({"kind": "ClusterProviderConfig", "name": location(s)})),
                format!("{key}: Object in location {}", location(s)));
            check(s!(r.live(key), "metadata", "namespace") == ns, format!("{key}: must land in the project namespace"));
            if s!(r.live(key), "kind") == "Secret" {
                check(!has!(r.live(key), "data") && !has!(r.live(key), "stringData"), format!("{key}: secret data must not be in the Object spec"));
            }
        }
        check(!r.live(&format!("{s}-connection")).is_null(), format!("{s}: the connection Secret in the location"));
    }

    check(l!(status, "sites").len() == sites.len(), format!("status.sites {}", repr(at!(status, "sites"))));
    check(s!(status, "connectionSecret") == format!("{name}-connection"), "status.connectionSecret".into());
    check(s!(r.cond("StackReady"), "type") == "StackReady", "StackReady condition missing".into());
}
