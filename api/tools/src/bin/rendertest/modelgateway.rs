use basis_tools::{at, has, l, m, s};
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::{Render, Set, eq, list_str, repr, same_obj_keys, set, unb64_lenient, v};

pub fn assert(r: &Render) {
    if r.kase == "selfhosted" {
        assert_self_hosted(r);
        return;
    }
    let (kase, state, status, name, ns) = (r.kase.as_str(), r.state.as_str(), &r.status, r.name.as_str(), r.ns.as_str());
    let check = |ok: bool, msg: String| r.check(ok, msg);
    let exposed = kase == "exposed";
    let geo = kase == "geo" || exposed;

    let location = |s: &str| if s == "recovery" { "onprem-ams" } else { "si-ske-demo" };
    let (sites, active) = if geo { (vec!["protected", "recovery"], "recovery") } else { (vec!["protected"], "protected") };
    check(s!(status, "activeSite") == active, format!("activeSite {:?}, want {active:?}", s!(status, "activeSite")));
    check(s!(status, "endpoint") == format!("http://{name}.{ns}.svc/v1") && s!(status, "keysSecret") == format!("{name}-keys"),
        format!("status endpoint {:?} keysSecret {:?}", s!(status, "endpoint"), s!(status, "keysSecret")));

    // --- a key per client, generated once and kept; removed clients' go
    let keys = m!(r.get("keys"), "data");
    let clients = if geo { set(&["apps"]) } else { set(&["support-bot", "coding-agent"]) };
    let got: Set = keys.into_iter().flat_map(|k| k.keys().cloned()).collect();
    check(same_obj_keys(keys, &clients), format!("keys for clients {}, want {}", list_str(&got), list_str(&clients)));
    if !geo && state == "observed" {
        let raw = unb64_lenient(s!(r.get("keys"), "data", "support-bot"));
        check(raw == "bot-key", "support-bot's key must be kept".into());
    }

    // --- per site: Agent Router in the location
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
        let ep = live("envoyproxy");
        check(eq(at!(ep, "spec", "provider", "kubernetes", "envoyService"), json!({"name": name, "type": "ClusterIP"})),
            format!("{s}: the gateway must be internal at a predictable name"));
        let replicas = if *s == active { 2 } else { 1 };
        check(eq(at!(ep, "spec", "provider", "kubernetes", "envoyDeployment", "replicas"), json!(replicas)), format!("{s}: gateway replicas"));
        check(s!(live("gateway"), "spec", "gatewayClassName") == "basis-ai", format!("{s}: gatewayClassName"));
        if exposed {
            check(eq(at!(live("external-envoyproxy"), "spec", "provider", "kubernetes", "envoyService"),
                json!({"name": format!("{name}-external"), "type": "LoadBalancer", "loadBalancerSourceRanges": ["203.0.113.0/24"]})),
                format!("{s}: the external Gateway on a LoadBalancer limited to the source ranges"));
            let cert = live("certificate");
            check(eq(at!(cert, "spec", "dnsNames"), json!(["llm.example.com"])) && s!(cert, "spec", "issuerRef", "name") == "basis"
                && s!(cert, "spec", "secretName") == format!("{name}-tls"), format!("{s}: certificate {}", repr(at!(cert, "spec"))));
            let listeners = l!(live("external-gateway"), "spec", "listeners");
            check(listeners.len() == 1 && s!(&listeners[0], "protocol") == "HTTPS" && eq(at!(&listeners[0], "port"), json!(443)),
                format!("{s}: the external Gateway is HTTPS only: {}", repr(Some(&Value::Array(listeners.to_vec())))));
            check(l!(live("route"), "spec", "parentRefs").len() == 2 && l!(live("securitypolicy"), "spec", "targetRefs").len() == 2,
                format!("{s}: route and key auth cover both Gateways"));
        } else {
            check(live("external-gateway").is_null() && live("certificate").is_null(), format!("{s}: external Gateway without spec.expose"));
        }
        // Token metrics for the Project's cost, an access log, the caller upstream.
        let eps = l!(live("podmonitor"), "spec", "podMetricsEndpoints");
        check(eps.len() == 2 && eq(at!(&eps[0], "targetPort"), json!(1064)) && s!(&eps[1], "port") == "metrics",
            format!("{s}: Agent Router's metrics from the extproc sidecar and Envoy's: {}", repr(Some(&Value::Array(eps.to_vec())))));
        check(s!(live("prometheusrule"), "kind") == "PrometheusRule", format!("{s}: latency and error alerts"));
        check(s!(ep, "spec", "telemetry", "accessLog", "settings", 0, "format", "json", "basis") == "gateway", format!("{s}: access log"));
        check(s!(live("securitypolicy"), "spec", "apiKeyAuth", "forwardClientIDHeader") == "x-basis-client", format!("{s}: client header"));
        let rl = live("ratelimit");
        if kase == "minimal" {
            let rules = l!(rl, "spec", "rateLimit", "global", "rules");
            check(rules.len() == 3 && s!(rl, "spec", "targetRefs", 0, "kind") == "HTTPRoute",
                format!("{s}: monthly caps for support-bot and the gateway, and requests per minute: {}", repr(Some(rl))));
            let retry = at!(live("backendtraffic"), "spec", "retry");
            check(eq(at!(v(retry), "numAttemptsPerPriority"), json!(2)) && eq(at!(v(retry), "numRetries"), json!(3)),
                format!("{s}: 2 attempts on the model and on its fallback: {}", repr(retry)));
            for rule in l!(live("route"), "spec", "rules") {
                if s!(rule, "matches", 0, "headers", 0, "value") == "gpt-4o-mini" {
                    let refs = l!(rule, "backendRefs");
                    check(refs.len() == 2 && eq(at!(&refs[1], "priority"), json!(1)),
                        format!("{s}: llama as gpt-4o-mini's fallback: {}", repr(Some(&Value::Array(refs.to_vec())))));
                }
            }
        } else {
            check(rl.is_null(), format!("{s}: no rate limits without monthlyTokens"));
        }
        let sp = live("securitypolicy");
        check(eq(at!(sp, "spec", "apiKeyAuth", "credentialRefs"), json!([{"name": format!("{name}-keys")}]))
            && eq(at!(sp, "spec", "apiKeyAuth", "sanitize"), json!(true)), format!("{s}: client API key auth"));
        let models: Set = l!(live("route"), "spec", "rules").iter().map(|rule| s!(rule, "matches", 0, "headers", 0, "value").to_string()).collect();
        let want = if geo { set(&["claude"]) } else { set(&["gpt-4o-mini", "llama"]) };
        check(models == want, format!("{s}: route models {}", list_str(&models)));
    }
    if geo {
        let policy = r.composed.keys().rfind(|k| k.starts_with("protected-model-") && k.ends_with("-backendsecurity"))
            .map(|k| r.live(k)).unwrap_or(&Value::Null);
        check(s!(policy, "spec", "type") == "AnthropicAPIKey", format!("Anthropic models use AnthropicAPIKey: {}", repr(Some(policy))));
    }
    check(l!(status, "sites").len() == sites.len(), format!("status.sites {}", repr(at!(status, "sites"))));
    let want_external = if exposed { "https://llm.example.com/v1" } else { "" };
    check(s!(status, "externalEndpoint") == want_external, format!("status.externalEndpoint {:?}", s!(status, "externalEndpoint")));
    check(s!(r.cond("GatewayReady"), "type") == "GatewayReady", "GatewayReady condition missing".into());
}

/// Models on ModelServers (required/selfhosted.yaml): llama on its
/// InferencePool in both sites, qwen (served under another name) through
/// its Service and in the protected site only, and as the hosted model's
/// fallback there.
fn assert_self_hosted(r: &Render) {
    let check = |ok: bool, msg: String| r.check(ok, msg);
    let rules = |site: &str| -> BTreeMap<String, Vec<Value>> {
        l!(r.live(&format!("{site}-route")), "spec", "rules").iter()
            .map(|rule| (s!(rule, "matches", 0, "headers", 0, "value").to_string(), l!(rule, "backendRefs").to_vec())).collect()
    };
    for site in ["protected", "recovery"] {
        let got = rules(site);
        let empty = vec![];
        let llama = got.get("llama").unwrap_or(&empty);
        check(llama.len() == 1 && s!(&llama[0], "kind") == "InferencePool" && s!(&llama[0], "group") == "inference.networking.k8s.io"
            && s!(&llama[0], "name") == "llama-inference-pool", format!("{site}: llama on its InferencePool: {}", repr(Some(&json!(llama)))));
        let gpt = got.get("gpt-4o-mini").unwrap_or(&empty);
        if site == "protected" {
            let qwen = got.get("qwen").unwrap_or(&empty);
            check(qwen.len() == 1 && !has!(&qwen[0], "kind") && s!(&qwen[0], "modelNameOverride") == "Qwen/Qwen3-0.6B",
                format!("{site}: qwen through its Service, renamed: {}", repr(Some(&json!(qwen)))));
            check(gpt.len() == 2 && eq(at!(&gpt[1], "priority"), json!(1)), format!("{site}: qwen as gpt-4o-mini's fallback: {}", repr(Some(&json!(gpt)))));
        } else {
            // Go's has() never sees a map of lists: only the length counts.
            check(gpt.len() == 1, format!("{site}: no qwen where its server doesn't run: {}", repr(Some(&json!(got)))));
        }
    }
    let backends: Vec<&str> = r.composed.keys().filter(|k| k.ends_with("-backend"))
        .map(|k| s!(r.live(k), "spec", "endpoints", 0, "fqdn", "hostname")).collect();
    check(backends.join(",").contains("qwen-small-kserve-workload-svc.ai-team.svc"), format!("qwen's Service as a backend: {backends:?}"));
    check(s!(&r.status, "message").contains("model qwen: ModelServer qwen-small doesn't run in the recovery site"),
        format!("status.message {:?}", s!(&r.status, "message")));
}
