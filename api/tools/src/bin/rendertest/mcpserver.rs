use basis_tools::doc::strs;
use basis_tools::{at, has, l, m, s};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::{Render, eq, repr, v};

pub fn assert(r: &Render) {
    let (kase, state, status, name, ns) = (r.kase.as_str(), r.state.as_str(), &r.status, r.name.as_str(), r.ns.as_str());
    let check = |ok: bool, msg: String| r.check(ok, msg);
    let (geo, cluster) = (kase == "geo", kase == "cluster");

    let location = |s: &str| if s == "recovery" { "onprem-ams" } else { "si-ske-demo" };
    let sites = if geo { vec!["protected", "recovery"] } else { vec!["protected"] };
    let active = if geo { "recovery" } else { "protected" };
    check(s!(status, "endpoint") == format!("http://{name}.{ns}.svc/mcp"), format!("status.endpoint {:?}", s!(status, "endpoint")));
    check(s!(status, "activeSite") == active, format!("status.activeSite {:?}, want {active:?}", s!(status, "activeSite")));
    check(l!(status, "sites").len() == sites.len(), format!("status.sites {}", repr(at!(status, "sites"))));
    check(s!(r.get("dashboard"), "kind") == "GrafanaDashboard" && s!(r.get("dashboard"), "spec", "uid") == s!(status, "dashboardUid"),
        "dashboard and status.dashboardUid".into());

    // Keys on the control plane: one per client that hasn't expired.
    let keys = v(at!(r.get("keys"), "data"));
    let want_clients = if cluster { vec!["claude-code", "support-bot"] } else { vec!["agents"] };
    let key_names: Vec<&String> = m!(keys).into_iter().flat_map(|m| m.keys()).collect();
    check(key_names.len() == want_clients.len(), format!("keys for {want_clients:?}: {}", repr(Some(&json!(key_names)))));
    for cl in &want_clients {
        check(has!(keys, *cl), format!("no key for {cl}"));
    }
    if cluster {
        check(eq(at!(status, "expiredClients"), json!(["intern"])), format!("status.expiredClients {}", repr(at!(status, "expiredClients"))));
    }
    if kase == "minimal" && state == "observed" {
        check(s!(keys, "agents") == "a2VwdC1rZXk=", format!("an existing key must be kept: {}", repr(Some(keys))));
    }

    let tools = if geo { "search,fetch,add_document,delete_document,remember,recall,forget" } else { "search,fetch,remember,recall,forget" };
    check(strs(at!(status, "tools")).join(",") == tools, format!("status.tools {}, want {tools}", repr(at!(status, "tools"))));

    for s in &sites {
        let live = |k: &str| r.live(&format!("{s}-{k}"));
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
        let replicas = match (geo, cluster) {
            (true, _) if *s == active => 3,
            (true, _) | (_, true) => 1,
            _ => 2,
        };
        let dep = live("deployment");
        check(s!(dep, "kind") == "Deployment" && s!(dep, "metadata", "name") == name, format!("{s}: Deployment {name}"));
        check(eq(at!(dep, "spec", "replicas"), json!(replicas)), format!("{s}: replicas {}, want {replicas}", repr(at!(dep, "spec", "replicas"))));
        let pod = v(at!(dep, "spec", "template", "spec"));
        check(eq(at!(pod, "securityContext", "runAsNonRoot"), json!(true)) && eq(at!(pod, "automountServiceAccountToken"), json!(false)),
            format!("{s}: restricted pod: {}", repr(at!(pod, "securityContext"))));
        let main = v(at!(pod, "containers", 0));
        check(eq(at!(main, "securityContext", "readOnlyRootFilesystem"), json!(true)), format!("{s}: read-only root"));
        check(s!(main, "readinessProbe", "httpGet", "path") == "/readyz", format!("{s}: ready once it has its database"));
        check(s!(main, "image").starts_with("ghcr.io/bartvanbenthem/basis-mcp:"), format!("{s}: image {}", s!(main, "image")));
        let env: BTreeMap<&str, &Value> = l!(main, "env").iter().map(|e| (s!(e, "name"), e)).collect();
        let e = |k: &str| v(env.get(k).copied());
        if cluster {
            check(s!(e("DATABASE_URL"), "value") == format!("postgresql://docs-rw.{ns}.svc:5432/wiki"), format!("{s}: DATABASE_URL {}", repr(env.get("DATABASE_URL").copied())));
            check(s!(e("PGPASSWORD"), "valueFrom", "secretKeyRef", "name") == format!("{name}-database"), format!("{s}: the role's password"));
            check(s!(e("OPENAI_BASE_URL"), "value") == format!("http://shared.{ns}.svc/v1")
                && s!(e("OPENAI_API_KEY"), "valueFrom", "secretKeyRef", "name") == format!("{name}-embeddings"),
                format!("{s}: embeddings env {}", repr(Some(&json!(env)))));
            let rf = v(at!(r.get(&format!("{s}-embeddings")), "spec", "references", 0));
            check(s!(rf, "patchesFrom", "name") == "shared-keys" && s!(rf, "patchesFrom", "fieldPath") == "data.wiki",
                format!("{s}: the server's key copied from the gateway: {}", repr(Some(rf))));
            check(s!(r.get(&format!("{s}-database")), "spec", "references", 0, "patchesFrom", "name") == "wiki-reader", format!("{s}: the role copied"));
        } else {
            check(s!(main, "envFrom", 0, "secretRef", "name") == "support-connection" && env.is_empty(),
                format!("{s}: the stack's connection Secret: {}", repr(Some(main))));
            check(r.get(&format!("{s}-database")).is_null() && r.get(&format!("{s}-embeddings")).is_null(), format!("{s}: a stack brings its credentials"));
        }

        let cfg: Value = match serde_json::from_str(s!(live("config"), "data", "config.json")) {
            Ok(c) => c,
            Err(err) => {
                check(false, format!("{s}: config.json: {err}"));
                continue;
            }
        };
        let mode = if geo || cluster { "hybrid" } else { "text" };
        check(s!(&cfg, "retrieval", "mode") == mode && s!(&cfg, "site") == *s, format!("{s}: config {}", repr(Some(&cfg))));
        if cluster {
            check(s!(&cfg, "retrieval", "table") == "public.chunks" && eq(at!(&cfg, "retrieval", "own"), json!(false))
                && s!(&cfg, "retrieval", "columns", "embedding") == "vec" && s!(&cfg, "memory", "scope") == "shared",
                format!("{s}: a table of your own: {}", repr(Some(&cfg))));
            check(eq(at!(&cfg, "clients", "support-bot", "tools"), json!(["search", "fetch", "recall"])) && !has!(&cfg, "clients", "intern"),
                format!("{s}: clients {}", repr(at!(&cfg, "clients"))));
        }

        check(s!(live("service"), "spec", "ports", 0, "targetPort") == "http", format!("{s}: Service"));
        check(live("pdb").is_null() != (replicas > 1), format!("{s}: a PodDisruptionBudget only with more than one replica"));
        let pm = live("podmonitor");
        check(s!(pm, "kind") == "PodMonitor" && s!(pm, "spec", "selector", "matchLabels", "ai.cndev.nl/mcpserver") == name
            && s!(pm, "spec", "podMetricsEndpoints", 0, "port") == "metrics", format!("{s}: metrics {}", repr(at!(pm, "spec"))));
        let rules = l!(live("prometheusrule"), "spec", "groups", 0, "rules");
        let want = if geo || cluster { 5 } else { 4 };
        check(rules.len() == want, format!("{s}: {} alerts, want {want}", rules.len()));
    }

    let ready = s!(r.cond("MCPServerReady"), "status");
    if kase == "minimal" && state == "observed" {
        check(ready == "True" && eq(at!(status, "ready"), json!(true)), format!("MCPServerReady {ready}, status {}", repr(Some(status))));
    } else {
        check(ready == "False", format!("MCPServerReady {ready} before the location reports"));
    }
}
