//! Composes a ModelGateway (ai.cndev.nl/v1alpha1): one OpenAI-compatible entry
//! point to a Project's models, on Agent Router, in its protected site and
//! optionally a standby in its recovery site.
//!
//! On the control plane, next to the XR:
//!
//!     keys               Secret <name>-keys: an API key per spec.clients entry,
//!                        generated once, then kept; a removed client's key goes
//!
//! In each site's location (provider-kubernetes Objects, prefix "<site>-"):
//!
//!     envoyproxy,        Agent Router on Envoy Gateway: an internal (ClusterIP)
//!     gateway,           Service <name>, client API key auth, and an
//!     clienttraffic,     AIGatewayRoute routing on the request's model to a
//!     backendtraffic,    backend per spec.models entry; 50Mi buffers for
//!     keys,              requests and responses
//!     securitypolicy,    (model-<hash>-{backend,aiservicebackend,tls,apikey,
//!     route, model-...   backendsecurity}); the client's name goes upstream
//!                        in x-basis-client, each request's tokens in metadata
//!     podmonitor         Agent Router's and Envoy's metrics (latency, tokens,
//!                        errors, retries), for the dashboard, the alerts and
//!                        the Project's cost
//!     prometheusrule     latency and error alerts (spec.alerts)
//!     ratelimit          with monthlyTokens or per-minute caps (per client or the
//!                        gateway): a BackendTrafficPolicy on the route
//!
//! On the control plane also: dashboard, a GrafanaDashboard in the Project's
//! Grafana.
//!
//! Both Gateways write an access log per request (client, model, tokens,
//! outcome; no prompts): the portal's audit trail. A client past its
//! expiresAt loses its key.
//!
//! With spec.expose, next to those in each site:
//!
//!     certificate,       a cert-manager Certificate <name>-tls for the hostname
//!     external-envoyproxy, from the ClusterIssuer spec.expose.issuer, and a Gateway
//!     external-gateway   <name>-external of its own: HTTPS only, on a LoadBalancer
//!                        Service <name>-external limited to the source ranges. The
//!                        route and the client key auth cover both Gateways; the
//!                        internal one stays plain HTTP, in-cluster only.
//!
//! The active site (spec.activeSite) gets spec.replicas, the standby
//! spec.recovery.replicas.
//!
//! Resilience: a model's route rule also lists its spec.models[].fallbacks,
//! each a priority lower; retries move on to the next priority after
//! spec.retry.attempts on one (Envoy's previous-priorities retry). Retries
//! live on the Gateways' BackendTrafficPolicy, so they never depend on the
//! rate limit store the token caps need.
//!
//! Self-hosted models: a spec.models entry with a server instead of an
//! endpoint names a ModelServer in the namespace, vLLM on KServe in the same
//! Project sites as the gateway. Where it can, the model's route rule hands
//! requests to the server's InferencePool: llm-d's endpoint picker then
//! chooses the replica most likely to have the prompt's prefix cached. Agent
//! Router can't rename the model for a pool, nor combine one with other
//! backends in a rule, so a model goes to the server's Service instead (an
//! OpenAI backend, round robin) when the server serves it under another name,
//! when it has fallbacks or is another model's fallback, or when the server
//! has prefix-cache-aware routing off. In a site the server doesn't run in,
//! the model isn't routed.

use k8s_openapi::ByteString;
use k8s_openapi::api::core::v1::Secret;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, LabelSelectorRequirement, ObjectMeta};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

use crate::common::gojson::{fmt_g, marshal, quote, quote_meta};
use crate::common::kinds::crds::aigateway::{ai_gateway_route as route, ai_service_backend as asb, backend_security_policy as bsp};
use crate::common::kinds::crds::cert_manager::certificate as cert;
use crate::common::kinds::crds::envoy_gateway::{
    backend as eb, backend_traffic_policy as btp, client_traffic_policy as ctp, envoy_proxy as ep, security_policy as sp,
};
use crate::common::kinds::crds::gateway_api::{backend_tls_policy as btls, gateway as gw};
use crate::common::kinds::crds::prometheus::pod_monitor as pm;
use crate::common::kinds::{
    Labels, alert, enum_value, location_object, meta, prometheus_rule, retype, scoped_dashboard, secret_copy, secret_field_copy, to_value,
};
use crate::common::lenient::decode;
use crate::common::util::{
    as_str, condition_true, dig_opt, live, new_secret, or, or_f, or_i, past_day, reported, sha1hex, unb64,
};
use crate::common::{Composed, Condition, Input, Output, Requirement, Result};
use crate::{lenient, modelserver};

/// The GatewayClass the Gateways use: Envoy Gateway's, created per location by
/// deps/ (see deps/README.md).
pub const GATEWAY_CLASS: &str = "basis-ai";
/// The Project the gateway's sites come from.
pub const REQUIRED_PROJECT: &str = "project";
/// Carries the calling client's name (its key's id) upstream.
pub const CLIENT_HEADER: &str = "x-basis-client";
/// Where Agent Router's sidecar serves its metrics.
pub const EXT_PROC_METRICS_PORT: i64 = 1064;

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
    /// The ModelGateway XR, as far as the composition reads it. Fields mirror
    /// apis/modelgateway/definition.yaml; the accessors repeat the XRD
    /// defaults so `crossplane render` and older objects come out the same.
    pub struct Xr { pub metadata: Metadata, pub spec: Spec, pub status: XrStatus }
}
lenient! {
    pub struct Recovery { pub enabled: bool, pub replicas: Option<i64> }
}
lenient! {
    /// How a failed request is retried: on the same model, then on its fallbacks.
    #[serde(rename_all = "camelCase")]
    pub struct Retry { pub attempts: Option<i64>, pub retry_on: Vec<i64>, pub per_try_timeout: String }
}
lenient! {
    /// Per-minute caps of requests and tokens.
    #[serde(rename_all = "camelCase")]
    pub struct PerMinute { pub requests_per_minute: i64, pub tokens_per_minute: i64 }
}
lenient! {
    /// The thresholds of the latency and error alerts.
    #[serde(rename_all = "camelCase")]
    pub struct Alerts {
        pub latency_seconds: f64,
        pub time_to_first_token_seconds: f64,
        pub error_rate_percent: f64,
        pub disabled: bool,
    }
}
lenient! {
    /// The gateway outside its location too, over HTTPS at hostname, on a
    /// LoadBalancer of its own; the internal endpoint stays as it is.
    #[serde(rename_all = "camelCase")]
    pub struct Expose {
        pub enabled: bool,
        pub hostname: String,
        pub issuer: String,
        pub annotations: BTreeMap<String, String>,
        pub load_balancer_source_ranges: Vec<String>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Client {
        pub name: String,
        pub requests_per_minute: i64,
        pub tokens_per_minute: i64,
        /// Who to ask about the key (a person or a group).
        pub owner: String,
        /// Caps this client's tokens per month (input and output).
        pub monthly_tokens: i64,
        /// The key's last day (YYYY-MM-DD); after it, revoked.
        pub expires_at: String,
    }
}
lenient! {
    pub struct SecretKey { pub name: String, pub key: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Model {
        pub name: String,
        pub endpoint: String,
        /// A ModelServer in the namespace, instead of an endpoint.
        pub server: String,
        pub schema: String,
        pub upstream_model: String,
        pub api_key_secret_ref: Option<SecretKey>,
        /// Other models in spec.models to try, in order, when this one fails.
        pub fallbacks: Vec<String>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Spec {
        pub replicas: i64,
        pub recovery: Recovery,
        pub active_site: String,
        pub clients: Option<Vec<Client>>,
        pub models: Vec<Model>,
        pub expose: Option<Expose>,
        /// Caps the gateway's tokens per month, all clients together.
        pub monthly_tokens: i64,
        pub retry: Option<Retry>,
        pub rate_limit: PerMinute,
        pub alerts: Alerts,
    }
}

impl PerMinute {
    fn set(&self) -> bool {
        self.requests_per_minute > 0 || self.tokens_per_minute > 0
    }
}

impl Client {
    /// Past the client's last day (UTC), its key is revoked.
    fn expired(&self) -> bool {
        past_day(&self.expires_at)
    }
    fn per_minute(&self) -> PerMinute {
        PerMinute { requests_per_minute: self.requests_per_minute, tokens_per_minute: self.tokens_per_minute }
    }
}

impl Model {
    fn schema(&self) -> &str {
        or(&self.schema, "OpenAI")
    }
}

impl Alerts {
    fn latency(&self) -> f64 {
        or_f(self.latency_seconds, 60.0)
    }
    fn first_token(&self) -> f64 {
        or_f(self.time_to_first_token_seconds, 10.0)
    }
    fn error_percent(&self) -> f64 {
        or_f(self.error_rate_percent, 5.0)
    }
}

impl Spec {
    fn replicas(&self) -> i64 {
        or_i(self.replicas, 2)
    }
    fn standby_replicas(&self) -> i64 {
        self.recovery.replicas.unwrap_or(1)
    }
    /// The serving site; recovery only while there is one.
    fn active_site(&self) -> &'static str {
        if self.active_site == SITE_RECOVERY && self.recovery.enabled { SITE_RECOVERY } else { SITE_PROTECTED }
    }
    fn expose(&self) -> Option<&Expose> {
        self.expose.as_ref().filter(|e| e.enabled)
    }
    /// spec.clients, or the default client apps.
    fn client_list(&self) -> Vec<Client> {
        self.clients.clone().unwrap_or_else(|| vec![Client { name: "apps".into(), ..Default::default() }])
    }
    /// The names of the clients whose keys are valid.
    fn clients(&self) -> Vec<String> {
        self.client_list().into_iter().filter(|c| !c.expired()).map(|c| c.name).collect()
    }
    /// Some client, or the gateway as a whole, has a monthly or per-minute cap.
    fn limited(&self) -> bool {
        self.monthly_tokens > 0
            || self.rate_limit.set()
            || self.client_list().iter().any(|c| (c.monthly_tokens > 0 || c.per_minute().set()) && !c.expired())
    }
    /// Attempts per model: spec.retry.attempts, 2 by default.
    fn attempts(&self) -> i64 {
        self.retry.as_ref().and_then(|r| r.attempts).map_or(2, |a| a.max(1))
    }
    /// The statuses retried: spec.retry.retryOn, or rate limits and server errors.
    fn retry_on(&self) -> Vec<i64> {
        match &self.retry {
            Some(r) if !r.retry_on.is_empty() => r.retry_on.clone(),
            _ => vec![429, 500, 502, 503, 504],
        }
    }
    /// A model's usable fallbacks: other models of the gateway, each once, in order.
    fn fallbacks(&self, m: &Model) -> Vec<String> {
        let known: BTreeSet<&str> = self.models.iter().map(|o| o.name.as_str()).collect();
        let mut seen = BTreeSet::from([m.name.as_str()]);
        let mut out = vec![];
        for f in &m.fallbacks {
            if known.contains(f.as_str()) && seen.insert(f.as_str()) {
                out.push(f.clone());
            }
        }
        out
    }
    /// The longest fallback chain of any model.
    fn max_fallbacks(&self) -> i64 {
        self.models.iter().map(|m| self.fallbacks(m).len() as i64).max().unwrap_or(0)
    }
}

/// The requirement name of ModelServer name.
pub fn required_server(name: &str) -> String {
    format!("server-{name}")
}

/// The Project (its sites) and the ModelServers spec.models names.
pub fn requirements(input: &Input) -> BTreeMap<String, Requirement> {
    let x: Xr = decode(&input.xr);
    let ns = x.metadata.namespace.as_str();
    let mut out = BTreeMap::from([(REQUIRED_PROJECT.to_string(), Requirement::named("platform.cndev.nl/v1alpha1", "Project", "", ns))]);
    for m in &x.spec.models {
        if !m.server.is_empty() {
            out.insert(required_server(&m.server), Requirement::named("ai.cndev.nl/v1alpha1", "ModelServer", ns, &m.server));
        }
    }
    out
}

/// The base URL OpenAI clients use for gateway name in namespace, the same in
/// every site's location.
pub fn endpoint(name: &str, namespace: &str) -> String {
    format!("http://{name}.{namespace}.svc/v1")
}

/// The base URL from outside the location at hostname.
pub fn external_endpoint(hostname: &str) -> String {
    format!("https://{hostname}/v1")
}

/// The Secret with the clients' API keys.
pub fn keys_secret(name: &str) -> String {
    format!("{name}-keys")
}

/// What the gateway knows of a ModelServer.
#[derive(Debug, Clone)]
struct Server {
    /// Crossplane looked it up; it exists.
    resolved: bool,
    found: bool,
    served: String,
    pool: bool,
    recovery: bool,
}

impl Server {
    fn runs_in(&self, site: &str) -> bool {
        !self.found || site == SITE_PROTECTED || self.recovery
    }
}

/// How a site's gateway reaches one of spec.models.
#[derive(Debug, Clone)]
struct Route {
    model: Model,
    /// A self-hosted model's InferencePool, instead of a backend.
    pool: String,
}

struct Composition<'a> {
    spec: &'a Spec,
    name: &'a str,
    ns: &'a str,
    observed: &'a BTreeMap<String, Value>,
    labels: Labels,
    servers: BTreeMap<String, Server>,
}

/// A manifest for a location, with how to tell it's ready.
struct Obj {
    manifest: Value,
    /// A Secret whose data comes from the control plane: from, and (field,
    /// to field) or None to copy data and type.
    copy_from: Option<(String, Option<(String, String)>)>,
    ready: fn(Option<&Value>) -> bool,
}

fn always(_: Option<&Value>) -> bool {
    true
}
fn object_ready(o: Option<&Value>) -> bool {
    condition_true(o, "Ready")
}
fn programmed(o: Option<&Value>) -> bool {
    condition_true(live(o), "Programmed")
}
fn live_ready(o: Option<&Value>) -> bool {
    condition_true(live(o), "Ready")
}

/// A URL as far as the gateway reads it.
struct Url {
    scheme: String,
    hostname: String,
    port: String,
    path: String,
}

/// url.Parse for the endpoints the XRD allows (scheme://host[:port][/path]).
fn parse_url(s: &str) -> Option<Url> {
    let (scheme, rest) = s.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (hostname, port) = if let Some(h) = host.strip_prefix('[') {
        let (h, p) = h.split_once(']')?;
        (h.to_string(), p.strip_prefix(':').unwrap_or("").to_string())
    } else {
        match host.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.to_string()),
            None => (host.to_string(), String::new()),
        }
    };
    let path = tail.split(['?', '#']).next().unwrap_or("").to_string();
    Some(Url { scheme: scheme.to_lowercase(), hostname, port, path })
}

/// Renders the desired state of a ModelGateway.
pub fn compose(input: &Input) -> Result<Output> {
    let xr: Xr = decode(&input.xr);
    let mut labels = Labels::from([
        ("app.kubernetes.io/managed-by".to_string(), "crossplane".to_string()),
        ("app.kubernetes.io/part-of".to_string(), "basis".to_string()),
        ("ai.cndev.nl/modelgateway".to_string(), xr.metadata.name.clone()),
    ]);
    // Owned by a GenAIStack: the same label on everything it composes, so
    // the stack's objects are found together.
    if let Some(stack) = xr.metadata.labels.get("ai.cndev.nl/genaistack").filter(|s| !s.is_empty()) {
        labels.insert("ai.cndev.nl/genaistack".into(), stack.clone());
    }
    let mut c = Composition {
        spec: &xr.spec, name: &xr.metadata.name, ns: &xr.metadata.namespace,
        observed: &input.observed, labels, servers: BTreeMap::new(),
    };
    c.resolve_servers(&input.required);
    let spec = c.spec;
    let mut out = Output::default();

    // ---- sites: pinned in status.sites, else the Project's locations
    let project = input.first(REQUIRED_PROJECT);
    let pinned: BTreeMap<&str, &str> = xr.status.sites.iter().map(|s| (s.site.as_str(), s.location.as_str())).collect();
    let location = |s: &str| -> String {
        or(pinned.get(s).copied().unwrap_or(""), as_str(dig_opt(project, &["spec", "locations", s]))).to_string()
    };
    let active = spec.active_site();
    let mut sites = vec![SITE_PROTECTED];
    if spec.recovery.enabled {
        sites.push(SITE_RECOVERY);
    }

    // ---- control plane: a key per client
    let mut keys = BTreeMap::new();
    for cl in spec.clients() {
        let key = keep(c.observed, "keys", &cl);
        keys.insert(cl, ByteString(key.into_bytes()));
    }
    let keys_ready = c.observed.contains_key("keys");
    let n_keys = keys.len();
    // Envoy Gateway API key auth: a key per client id.
    out.composed.insert("keys".into(), Composed { ready: keys_ready, object: to_value(&Secret {
        metadata: c.meta(&keys_secret(c.name)), type_: Some("Opaque".into()), data: Some(keys), ..Default::default()
    })});

    // The gateway's dashboard in the Project's Grafana, on the control plane.
    let dashboard = c.dashboard();
    let dashboard_uid = dashboard["spec"]["uid"].clone();
    out.composed.insert("dashboard".into(), Composed { ready: true, object: dashboard });

    let mut status = json!({"ready": false, "message": "", "activeSite": active, "models": spec.models.len(), "clients": n_keys,
        "endpoint": endpoint(c.name, c.ns), "keysSecret": keys_secret(c.name), "sites": [], "dashboardUid": dashboard_uid});
    let expired: Vec<String> = spec.client_list().into_iter().filter(|cl| cl.expired()).map(|cl| cl.name).collect();
    if !expired.is_empty() {
        status["expiredClients"] = json!(expired);
    }
    if let Some(e) = spec.expose() {
        status["externalEndpoint"] = json!(external_endpoint(&e.hostname));
    }
    let mut problems: Vec<String> = vec![];
    let mut external: Vec<String> = vec![];
    let mut all_ready = keys_ready;
    let mut site_status = vec![];
    for s in &sites {
        let replicas = if *s == active { spec.replicas() } else { spec.standby_replicas() };
        let loc = location(s);
        let mut ss = json!({"site": s, "location": loc, "active": *s == active, "replicas": replicas});
        if loc.is_empty() {
            site_status.push(ss);
            problems.push(format!("Project {} has no {s} location (spec.locations.{s})", c.ns));
            all_ready = false;
            continue;
        }
        let mut internal_ready = true;
        for (key, o) in c.site_objects(s, replicas)? {
            let k = format!("{s}-{key}");
            let mut w = c.wrap(&k, &loc, o.manifest, o.copy_from.as_ref());
            w.ready = (o.ready)(c.observed.get(&k));
            all_ready = all_ready && w.ready;
            if !key.starts_with("external-") && key != "certificate" {
                internal_ready = internal_ready && w.ready;
            }
            out.composed.insert(k, w);
        }
        if let Some(e) = spec.expose() {
            let address = dig_opt(live(c.observed.get(&format!("{s}-external-gateway"))), &["status", "addresses"])
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .map(|a| as_str(a.get("value")).to_string())
                .unwrap_or_default();
            if !address.is_empty() {
                ss["address"] = json!(address);
            }
            // Only once Agent Router runs: then what's missing is outside it.
            if internal_ready {
                if !live_ready(c.observed.get(&format!("{s}-certificate"))) {
                    external.push(format!("certificate {}-tls in {loc} (cert-manager ClusterIssuer {})", c.name, or(&e.issuer, "basis")));
                }
                if address.is_empty() {
                    external.push(format!("a LoadBalancer address in {loc}"));
                }
            }
        }
        site_status.push(ss);
    }
    status["sites"] = json!(site_status);

    status["ready"] = json!(all_ready);
    let notes = c.server_notes(&sites);
    let mut cond = Condition { status: all_ready, reason: "Available".into(), message: String::new() };
    let mut msg = if !problems.is_empty() {
        cond.reason = "Waiting".into();
        problems.join("; ")
    } else if !all_ready && !external.is_empty() {
        cond.reason = "Creating".into();
        format!("Waiting for the external endpoint: {}", external.join(", "))
    } else if !all_ready {
        cond.reason = "Creating".into();
        "Waiting for Agent Router in the location(s)".to_string()
    } else if spec.models.is_empty() {
        format!("Gateway {} is ready, without models: add some to spec.models", c.name)
    } else {
        format!("Gateway {} is ready with {} model(s); active site {active}", c.name, spec.models.len())
    };
    if !notes.is_empty() {
        msg = format!("{msg}; {}", notes.join("; "));
    }
    status["message"] = json!(msg);
    cond.message = msg;
    out.status = status;
    out.condition = cond;
    Ok(out)
}

/// A generated value, read back from the observed composed Secret once it exists.
fn keep(observed: &BTreeMap<String, Value>, key: &str, field: &str) -> String {
    dig_opt(observed.get(key), &["data", field])
        .and_then(Value::as_str)
        .and_then(unb64)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| new_secret(40))
}

/// spec.models by name: the order of the route's rules.
fn sorted_models(models: &[Model]) -> Vec<Model> {
    let mut out = models.to_vec();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

impl Composition<'_> {
    /// The ModelServers spec.models names, as far as they're resolved.
    fn resolve_servers(&mut self, required: &BTreeMap<String, Vec<Value>>) {
        for m in &self.spec.models {
            if m.server.is_empty() {
                continue;
            }
            let items = required.get(&required_server(&m.server));
            let mut s = Server { resolved: items.is_some(), found: false, served: m.name.clone(), pool: true, recovery: false };
            if let Some(obj) = items.and_then(|i| i.first()) {
                s.found = true;
                s.served = modelserver::served_name(obj);
                if let Some(v) = obj.pointer("/spec/routing/prefixCacheAware").and_then(Value::as_bool) {
                    s.pool = v;
                }
                s.recovery = obj.pointer("/spec/recovery/enabled").and_then(Value::as_bool).unwrap_or(false);
            }
            self.servers.insert(m.server.clone(), s);
        }
    }

    /// The models a site's gateway serves, sorted by name (the order of the
    /// route's rules), self-hosted ones resolved to their server's
    /// InferencePool or Service.
    fn routes(&self, site: &str) -> Vec<Route> {
        let spec = self.spec;
        let fallback: BTreeSet<String> = spec.models.iter().flat_map(|m| spec.fallbacks(m)).collect();
        let mut out = vec![];
        for m in sorted_models(&spec.models) {
            if m.server.is_empty() {
                out.push(Route { model: m, pool: String::new() });
                continue;
            }
            let s = self.servers[&m.server].clone();
            if !s.runs_in(site) {
                continue;
            }
            if s.pool && s.served == m.name && spec.fallbacks(&m).is_empty() && !fallback.contains(&m.name) {
                let pool = modelserver::inference_pool(&m.server);
                out.push(Route { model: m, pool });
                continue;
            }
            let mut r = m.clone();
            r.endpoint = modelserver::endpoint(&m.server, self.ns);
            r.schema = "OpenAI".into();
            r.api_key_secret_ref = None;
            r.upstream_model = if s.served != m.name { s.served.clone() } else { String::new() };
            out.push(Route { model: r, pool: String::new() });
        }
        out
    }

    /// What keeps self-hosted models from serving: a ModelServer that doesn't
    /// exist, or doesn't run in one of the gateway's sites.
    fn server_notes(&self, sites: &[&str]) -> Vec<String> {
        let mut notes = vec![];
        for m in sorted_models(&self.spec.models) {
            let Some(s) = self.servers.get(&m.server) else { continue };
            if s.resolved && !s.found {
                notes.push(format!("model {}: no ModelServer {} in {}", m.name, m.server, self.ns));
                continue;
            }
            for site in sites {
                if !s.runs_in(site) {
                    notes.push(format!("model {}: ModelServer {} doesn't run in the {site} site (its spec.recovery)", m.name, m.server));
                }
            }
        }
        notes
    }

    /// The name of a model's Backend, AIServiceBackend and policies.
    fn model_object(&self, name: &str) -> String {
        format!("{}-model-{}", self.name, &sha1hex(name)[..8])
    }

    /// What runs in a site's location, by composition resource name (without
    /// the site prefix).
    fn site_objects(&self, site: &str, replicas: i64) -> Result<BTreeMap<String, Obj>> {
        let spec = self.spec;
        let name = self.name;
        let mut out: BTreeMap<String, Obj> = BTreeMap::new();
        let mut add = |k: &str, ready: fn(Option<&Value>) -> bool, manifest: Value| {
            out.insert(k.into(), Obj { manifest, copy_from: None, ready });
        };
        let envoy_proxy = |name: &str, service: ep::EnvoyProxyProviderKubernetesEnvoyService| ep::EnvoyProxy {
            metadata: self.meta(name),
            spec: ep::EnvoyProxySpec {
                provider: Some(ep::EnvoyProxyProvider {
                    r#type: ep::EnvoyProxyProviderType::Kubernetes,
                    kubernetes: Some(ep::EnvoyProxyProviderKubernetes {
                        envoy_service: Some(service),
                        envoy_deployment: Some(ep::EnvoyProxyProviderKubernetesEnvoyDeployment { replicas: Some(replicas as i32), ..Default::default() }),
                        ..Default::default()
                    }),
                    host: None,
                }),
                telemetry: Some(telemetry()),
                ..Default::default()
            },
            status: None,
        };
        let gateway = |name: &str, listener: gw::GatewayListeners| gw::Gateway {
            metadata: self.meta(name),
            spec: gw::GatewaySpec {
                gateway_class_name: GATEWAY_CLASS.into(),
                listeners: vec![listener],
                infrastructure: Some(gw::GatewayInfrastructure {
                    parameters_ref: Some(gw::GatewayInfrastructureParametersRef {
                        group: "gateway.envoyproxy.io".into(), kind: "EnvoyProxy".into(), name: name.into(),
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
            status: None,
        };
        // Internal: clients in the location only, at a predictable name.
        add("envoyproxy", reported, to_value(&envoy_proxy(name, ep::EnvoyProxyProviderKubernetesEnvoyService {
            name: Some(name.into()), r#type: Some(ep::EnvoyProxyProviderKubernetesEnvoyServiceType::ClusterIp), ..Default::default()
        })));
        add("gateway", programmed, to_value(&gateway(name, gw::GatewayListeners {
            name: "http".into(), protocol: "HTTP".into(), port: 80, ..Default::default()
        })));
        let mut gateways = vec![name.to_string()];
        if let Some(e) = spec.expose() {
            // A Gateway of its own: the LoadBalancer carries the HTTPS listener
            // only, never the internal plain HTTP one.
            let external = format!("{name}-external");
            add("external-envoyproxy", reported, to_value(&envoy_proxy(&external, ep::EnvoyProxyProviderKubernetesEnvoyService {
                name: Some(external.clone()),
                r#type: Some(ep::EnvoyProxyProviderKubernetesEnvoyServiceType::LoadBalancer),
                load_balancer_source_ranges: Some(e.load_balancer_source_ranges.clone()),
                annotations: (!e.annotations.is_empty()).then(|| e.annotations.clone()),
                ..Default::default()
            })));
            add("certificate", live_ready, to_value(&cert::Certificate {
                metadata: self.meta(&format!("{name}-tls")),
                spec: cert::CertificateSpec {
                    secret_name: format!("{name}-tls"),
                    dns_names: Some(vec![e.hostname.clone()]),
                    issuer_ref: cert::CertificateIssuerRef {
                        group: Some("cert-manager.io".into()), kind: Some("ClusterIssuer".into()), name: or(&e.issuer, "basis").into(),
                    },
                    ..Default::default()
                },
                status: None,
            }));
            add("external-gateway", programmed, to_value(&gateway(&external, gw::GatewayListeners {
                name: "https".into(),
                protocol: "HTTPS".into(),
                port: 443,
                hostname: Some(e.hostname.clone()),
                tls: Some(gw::GatewayListenersTls {
                    mode: Some(gw::GatewayListenersTlsMode::Terminate),
                    certificate_refs: Some(vec![gw::GatewayListenersTlsCertificateRefs {
                        kind: Some("Secret".into()), name: format!("{name}-tls"), ..Default::default()
                    }]),
                    ..Default::default()
                }),
                ..Default::default()
            })));
            gateways.push(external);
        }
        // The policies' targets: (group, kind, name) of each Gateway.
        let targets = || gateways.iter().map(|g| ("gateway.networking.k8s.io".to_string(), "Gateway".to_string(), g.clone()));
        add("clienttraffic", reported, to_value(&ctp::ClientTrafficPolicy {
            metadata: self.meta(name),
            // Prompts with context, and images, can be large. Over HTTP/2 (the
            // exposed Gateway's HTTPS) a request is also limited to the stream's
            // flow-control window, 64Ki by default: one photo is more, a 413.
            spec: ctp::ClientTrafficPolicySpec {
                target_refs: Some(targets().map(|(group, kind, name)| ctp::ClientTrafficPolicyTargetRefs { group, kind, name, section_name: None }).collect()),
                connection: Some(ctp::ClientTrafficPolicyConnection { buffer_limit: Some(BUFFER_LIMIT.clone()), ..Default::default() }),
                http2: Some(ctp::ClientTrafficPolicyHttp2 {
                    initial_stream_window_size: Some(BUFFER_LIMIT.clone()),
                    initial_connection_window_size: Some(BUFFER_LIMIT.clone()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            status: None,
        }));
        add("backendtraffic", reported, to_value(&btp::BackendTrafficPolicy {
            metadata: self.meta(name),
            // Agent Router's per-backend filter buffers whole responses on the
            // upstream connection, 32Ki by default: an embedding (4096 floats as
            // JSON) or a long completion is more, and fails with a 500.
            spec: btp::BackendTrafficPolicySpec {
                target_refs: Some(targets().map(|(group, kind, name)| btp::BackendTrafficPolicyTargetRefs { group, kind, name, section_name: None }).collect()),
                connection: Some(btp::BackendTrafficPolicyConnection { buffer_limit: Some(BUFFER_LIMIT.clone()), ..Default::default() }),
                // Retries, and with them the fallbacks.
                retry: self.retry_policy(),
                ..Default::default()
            },
            status: None,
        }));
        out.insert("keys".into(), Obj { ready: object_ready, copy_from: Some((keys_secret(name), None)),
            manifest: to_value(&Secret { metadata: self.meta(&keys_secret(name)), ..Default::default() }) });
        out.insert("securitypolicy".into(), Obj { ready: reported, copy_from: None, manifest: to_value(&sp::SecurityPolicy {
            metadata: self.meta(name),
            spec: sp::SecurityPolicySpec {
                target_refs: Some(targets().map(|(group, kind, name)| sp::SecurityPolicyTargetRefs { group, kind, name, section_name: None }).collect()),
                // OpenAI clients send Authorization: Bearer <key>; it isn't forwarded.
                api_key_auth: Some(sp::SecurityPolicyApiKeyAuth {
                    credential_refs: vec![sp::SecurityPolicyApiKeyAuthCredentialRefs { name: keys_secret(name), ..Default::default() }],
                    extract_from: vec![sp::SecurityPolicyApiKeyAuthExtractFrom { headers: Some(vec!["Authorization".into()]), ..Default::default() }],
                    sanitize: Some(true),
                    // Who called: for the token limits and the access log.
                    forward_client_id_header: Some(CLIENT_HEADER.into()),
                }),
                ..Default::default()
            },
            status: None,
        }) });

        let mut rules = vec![];
        let routes = self.routes(site);
        let by_name: BTreeMap<String, Model> = routes.iter().map(|r| (r.model.name.clone(), r.model.clone())).collect();
        let models: Vec<Model> = routes.iter().map(|r| r.model.clone()).collect();
        let model_match = |m: &Model| Some(vec![route::AiGatewayRouteRulesMatches { headers: Some(vec![route::AiGatewayRouteRulesMatchesHeaders {
            r#type: Some(route::AiGatewayRouteRulesMatchesHeadersType::Exact), name: "x-ai-eg-model".into(), value: m.name.clone(),
        }]) }]);
        for r in &routes {
            let m = &r.model;
            if !r.pool.is_empty() {
                // A self-hosted model's InferencePool: its endpoint picker chooses the replica.
                rules.push(route::AiGatewayRouteRules {
                    matches: model_match(m),
                    backend_refs: Some(vec![route::AiGatewayRouteRulesBackendRefs {
                        group: Some("inference.networking.k8s.io".into()), kind: Some("InferencePool".into()), name: r.pool.clone(),
                        ..Default::default()
                    }]),
                    ..Default::default()
                });
                continue;
            }
            let id = format!("model-{}", &sha1hex(&m.name)[..8]);
            let obj = self.model_object(&m.name);
            let u = parse_url(&m.endpoint)
                .filter(|u| !u.hostname.is_empty())
                .ok_or_else(|| format!("model {}: endpoint {} is not a URL", quote(&m.name), quote(&m.endpoint)))?;
            let tls = u.scheme == "https";
            let mut port = if tls { 443 } else { 80 };
            if !u.port.is_empty() {
                port = u.port.parse::<i32>().unwrap_or(0);
            }
            out.insert(format!("{id}-backend"), Obj { ready: reported, copy_from: None, manifest: to_value(&eb::Backend {
                metadata: self.meta(&obj),
                spec: eb::BackendSpec {
                    endpoints: Some(vec![eb::BackendEndpoints {
                        fqdn: Some(eb::BackendEndpointsFqdn { hostname: u.hostname.clone(), port }), ..Default::default()
                    }]),
                    ..Default::default()
                },
                status: None,
            }) });
            let prefix = u.path.strip_suffix('/').unwrap_or(&u.path);
            out.insert(format!("{id}-aiservicebackend"), Obj { ready: reported, copy_from: None, manifest: to_value(&asb::AiServiceBackend {
                metadata: self.meta(&obj),
                spec: asb::AiServiceBackendSpec {
                    schema: asb::AiServiceBackendSchema {
                        name: enum_value("spec.models[].schema", m.schema())?, prefix: (!prefix.is_empty()).then(|| prefix.into()), version: None,
                    },
                    backend_ref: asb::AiServiceBackendBackendRef {
                        group: Some("gateway.envoyproxy.io".into()), kind: Some("Backend".into()), name: obj.clone(), ..Default::default()
                    },
                    body_mutation: None,
                    header_mutation: None,
                    header_value_filters: None,
                },
                status: None,
            }) });
            if tls {
                out.insert(format!("{id}-tls"), Obj { ready: reported, copy_from: None, manifest: to_value(&btls::BackendTlsPolicy {
                    metadata: self.meta(&obj),
                    spec: btls::BackendTlsPolicySpec {
                        target_refs: vec![btls::BackendTlsPolicyTargetRefs {
                            group: "gateway.envoyproxy.io".into(), kind: "Backend".into(), name: obj.clone(), section_name: None,
                        }],
                        validation: btls::BackendTlsPolicyValidation {
                            well_known_ca_certificates: Some("System".into()), hostname: u.hostname.clone(), ..Default::default()
                        },
                        ..Default::default()
                    },
                    status: None,
                }) });
            }
            if let Some(r) = &m.api_key_secret_ref {
                // The provider's key under "apiKey", as Agent Router reads it.
                let secret = format!("{obj}-apikey");
                out.insert(format!("{id}-apikey"), Obj { ready: object_ready,
                    copy_from: Some((r.name.clone(), Some((format!("data.{}", or(&r.key, "apiKey")), "data.apiKey".into())))),
                    manifest: to_value(&Secret { metadata: self.meta(&secret), type_: Some("Opaque".into()), ..Default::default() }) });
                let anthropic = m.schema() == "Anthropic";
                let policy = bsp::BackendSecurityPolicySpec {
                    target_refs: Some(vec![bsp::BackendSecurityPolicyTargetRefs {
                        group: "aigateway.envoyproxy.io".into(), kind: "AIServiceBackend".into(), name: obj.clone(),
                    }]),
                    r#type: if anthropic { bsp::BackendSecurityPolicyType::AnthropicApiKey } else { bsp::BackendSecurityPolicyType::ApiKey },
                    anthropic_api_key: anthropic.then(|| bsp::BackendSecurityPolicyAnthropicApiKey {
                        secret_ref: bsp::BackendSecurityPolicyAnthropicApiKeySecretRef { name: secret.clone(), ..Default::default() },
                    }),
                    api_key: (!anthropic).then(|| bsp::BackendSecurityPolicyApiKey {
                        secret_ref: bsp::BackendSecurityPolicyApiKeySecretRef { name: secret.clone(), ..Default::default() },
                    }),
                    aws_credentials: None,
                    azure_api_key: None,
                    azure_credentials: None,
                    credential_override: None,
                    gcp_credentials: None,
                };
                out.insert(format!("{id}-backendsecurity"), Obj { ready: reported, copy_from: None, manifest: to_value(&bsp::BackendSecurityPolicy {
                    metadata: self.meta(&obj), spec: policy, status: None,
                }) });
            }
            rules.push(route::AiGatewayRouteRules {
                matches: model_match(m),
                // The model, then its fallbacks.
                backend_refs: Some(self.backend_refs(m, &by_name)),
                ..Default::default()
            });
        }
        if !rules.is_empty() {
            let cost = |key: &str, r#type: route::AiGatewayRouteLlmRequestCostsType| route::AiGatewayRouteLlmRequestCosts {
                metadata_key: key.into(), r#type, cel: None,
            };
            out.insert("route".into(), Obj { ready: reported, copy_from: None, manifest: to_value(&route::AiGatewayRoute {
                metadata: self.meta(name),
                spec: route::AiGatewayRouteSpec {
                    parent_refs: Some(targets().map(|(group, kind, name)| route::AiGatewayRouteParentRefs {
                        group: Some(group), kind: Some(kind), name, ..Default::default()
                    }).collect()),
                    rules,
                    // Each request's tokens, for the token limits and the access log.
                    llm_request_costs: Some(vec![
                        cost("llm_input_token", route::AiGatewayRouteLlmRequestCostsType::InputToken),
                        cost("llm_output_token", route::AiGatewayRouteLlmRequestCostsType::OutputToken),
                        cost("llm_total_token", route::AiGatewayRouteLlmRequestCostsType::TotalToken),
                    ]),
                    ..Default::default()
                },
                status: None,
            }) });
            if spec.limited() {
                out.insert("ratelimit".into(), Obj { ready: always, copy_from: None, manifest: self.token_limits() });
            }
        }
        // The token usage per model (Agent Router's gen_ai_* metrics) for the
        // Project's Prometheus: what its cost rules price.
        out.insert("podmonitor".into(), Obj { ready: always, copy_from: None, manifest: self.pod_monitor(gateways, &models) });
        if !spec.alerts.disabled {
            out.insert("prometheusrule".into(), Obj { ready: always, copy_from: None, manifest: self.alert_rules() });
        }
        Ok(out)
    }

    /// A model's backend and, a priority lower each, its fallbacks'.
    fn backend_refs(&self, m: &Model, by_name: &BTreeMap<String, Model>) -> Vec<route::AiGatewayRouteRulesBackendRefs> {
        let r = |m: &Model, priority: usize| route::AiGatewayRouteRulesBackendRefs {
            name: self.model_object(&m.name),
            model_name_override: if !m.upstream_model.is_empty() {
                Some(m.upstream_model.clone())
            } else {
                // A fallback gets the request for another model: name its own.
                (priority > 0).then(|| m.name.clone())
            },
            priority: (priority > 0).then_some(priority as i32),
            ..Default::default()
        };
        let mut refs = vec![r(m, 0)];
        for f in self.spec.fallbacks(m) {
            // Only the fallbacks this site serves.
            if let Some(fb) = by_name.get(&f) {
                let p = refs.len();
                refs.push(r(fb, p));
            }
        }
        refs
    }

    /// The Gateways' retry: attempts per model on the retried statuses and
    /// connection failures, with backoff; with fallbacks, moving to the next
    /// one after that many. None when nothing is retried.
    fn retry_policy(&self) -> Option<btp::BackendTrafficPolicyRetry> {
        let attempts = self.spec.attempts();
        let priorities = 1 + self.spec.max_fallbacks();
        let retries = attempts * priorities - 1;
        if retries <= 0 {
            return None;
        }
        Some(btp::BackendTrafficPolicyRetry {
            num_retries: Some(retries as i32),
            retry_on: Some(btp::BackendTrafficPolicyRetryRetryOn {
                triggers: Some(["connect-failure", "reset", "retriable-status-codes"].map(String::from).to_vec()),
                http_status_codes: Some(self.spec.retry_on()),
            }),
            per_retry: Some(btp::BackendTrafficPolicyRetryPerRetry {
                back_off: Some(btp::BackendTrafficPolicyRetryPerRetryBackOff {
                    base_interval: Some("250ms".into()), max_interval: Some("5s".into()),
                }),
                timeout: self.spec.retry.as_ref().filter(|r| !r.per_try_timeout.is_empty()).map(|r| r.per_try_timeout.clone()),
            }),
            num_attempts_per_priority: (priorities > 1).then_some(attempts as i32),
        })
    }

    /// The per-minute caps, per client and for the gateway: a request counts 1
    /// when it arrives, a token cap is charged with each response's total tokens.
    fn minute_rules(&self, token_cost: &btp::BackendTrafficPolicyRateLimitGlobalRulesCost) -> Vec<btp::BackendTrafficPolicyRateLimitGlobalRules> {
        let mut rules = vec![];
        let mut add = |client: Option<&str>, p: PerMinute| {
            if p.requests_per_minute > 0 {
                rules.push(rate_rule(client, p.requests_per_minute, btp::BackendTrafficPolicyRateLimitGlobalRulesLimitUnit::Minute, None));
            }
            if p.tokens_per_minute > 0 {
                rules.push(rate_rule(client, p.tokens_per_minute, btp::BackendTrafficPolicyRateLimitGlobalRulesLimitUnit::Minute,
                    Some(token_cost.clone())));
            }
        };
        for cl in self.spec.client_list() {
            if !cl.expired() {
                add(Some(&cl.name), cl.per_minute());
            }
        }
        add(None, self.spec.rate_limit.clone());
        rules
    }

    /// The monthly token caps: per client, and for the gateway as a whole.
    /// Global rate limits (Envoy Gateway's rate limit service, see
    /// deps/README.md) on the route, charged with each response's total
    /// tokens; a request is refused (429) once its counter is used up. Shared
    /// by both Gateways; each site counts on its own.
    fn token_limits(&self) -> Value {
        let cost = btp::BackendTrafficPolicyRateLimitGlobalRulesCost {
            request: Some(btp::BackendTrafficPolicyRateLimitGlobalRulesCostRequest {
                from: btp::BackendTrafficPolicyRateLimitGlobalRulesCostRequestFrom::Number, number: Some(0), metadata: None,
            }),
            response: Some(btp::BackendTrafficPolicyRateLimitGlobalRulesCostResponse {
                from: btp::BackendTrafficPolicyRateLimitGlobalRulesCostResponseFrom::Metadata,
                metadata: Some(btp::BackendTrafficPolicyRateLimitGlobalRulesCostResponseMetadata {
                    namespace: "io.envoy.ai_gateway".into(), key: "llm_total_token".into(),
                }),
                number: None,
            }),
        };
        let month = btp::BackendTrafficPolicyRateLimitGlobalRulesLimitUnit::Month;
        let mut rules = vec![];
        for cl in self.spec.client_list() {
            if cl.monthly_tokens > 0 && !cl.expired() {
                rules.push(rate_rule(Some(&cl.name), cl.monthly_tokens, month.clone(), Some(cost.clone())));
            }
        }
        if self.spec.monthly_tokens > 0 {
            rules.push(rate_rule(None, self.spec.monthly_tokens, month, Some(cost.clone())));
        }
        rules.extend(self.minute_rules(&cost));
        to_value(&btp::BackendTrafficPolicy {
            metadata: self.meta(&format!("{}-limits", self.name)),
            spec: btp::BackendTrafficPolicySpec {
                // The HTTPRoute Agent Router makes of the AIGatewayRoute, merged
                // into the Gateways' policy (its buffers) rather than replacing it.
                target_refs: Some(vec![btp::BackendTrafficPolicyTargetRefs {
                    group: "gateway.networking.k8s.io".into(), kind: "HTTPRoute".into(), name: self.name.into(), section_name: None,
                }]),
                merge_type: Some("StrategicMerge".into()),
                rate_limit: Some(btp::BackendTrafficPolicyRateLimit {
                    r#type: Some(btp::BackendTrafficPolicyRateLimitType::Global),
                    global: Some(btp::BackendTrafficPolicyRateLimitGlobal { rules }),
                    ..Default::default()
                }),
                ..Default::default()
            },
            status: None,
        })
    }

    /// Puts a location object into a provider-kubernetes Object.
    fn wrap(&self, key: &str, location: &str, manifest: Value, copy_from: Option<&(String, Option<(String, String)>)>) -> Composed {
        // The Secret's data comes from the control plane, never through this spec.
        let references = match copy_from {
            None => vec![],
            Some((from, None)) => secret_copy(self.ns, from),
            Some((from, Some((field, to)))) => secret_field_copy(self.ns, from, field, to),
        };
        let metadata = meta(&format!("{}-{key}", self.name), self.ns, &self.labels);
        Composed { ready: false, object: to_value(&location_object(metadata, location, manifest, references)) }
    }

    fn meta(&self, name: &str) -> ObjectMeta {
        meta(name, self.ns, &self.labels)
    }

    /// Scrapes the gateway's Envoy proxies: Agent Router's gen_ai_* metrics
    /// from the extproc sidecar and a few Envoy statistics, every series
    /// labelled with the gateway (the exposed Gateway's proxies too) and
    /// Envoy's with the model of its route rule.
    fn pod_monitor(&self, gateways: Vec<String>, models: &[Model]) -> Value {
        let gateway = pm::PodMonitorPodMetricsEndpointsRelabelings {
            source_labels: Some(vec!["__meta_kubernetes_pod_label_gateway_envoyproxy_io_owning_gateway_name".into()]),
            regex: Some("(.+?)(-external)?".into()), target_label: Some("gateway".into()), replacement: Some("$1".into()),
            ..Default::default()
        };
        // Agent Router turns the AIGatewayRoute into HTTPRoute <name>, a rule
        // per model in the order the composition writes them (sorted by name).
        let mut keep = vec![pm::PodMonitorPodMetricsEndpointsMetricRelabelings {
            source_labels: Some(vec!["__name__".into()]), regex: Some(ENVOY_METRICS.into()),
            action: Some(pm::PodMonitorPodMetricsEndpointsMetricRelabelingsAction::Keep), ..Default::default()
        }];
        for (i, m) in models.iter().enumerate() {
            keep.push(pm::PodMonitorPodMetricsEndpointsMetricRelabelings {
                source_labels: Some(vec!["envoy_cluster_name".into()]),
                regex: Some(quote_meta(&format!("httproute/{}/{}/rule/{i}", self.ns, self.name))),
                target_label: Some("model".into()), replacement: Some(m.name.clone()),
                ..Default::default()
            });
        }
        let selector = LabelSelector {
            match_expressions: Some(vec![LabelSelectorRequirement {
                key: "gateway.envoyproxy.io/owning-gateway-name".into(), operator: "In".into(), values: Some(gateways),
            }]),
            ..Default::default()
        };
        let endpoint = |path: &str| pm::PodMonitorPodMetricsEndpoints {
            path: Some(path.into()), interval: Some("30s".into()), relabelings: Some(vec![gateway.clone()]), ..Default::default()
        };
        to_value(&pm::PodMonitor {
            metadata: self.meta(&format!("{}-tokens", self.name)),
            spec: pm::PodMonitorSpec {
                selector: retype(&selector),
                pod_metrics_endpoints: Some(vec![
                    // The ai-gateway-extproc sidecar's admin port (no named port).
                    pm::PodMonitorPodMetricsEndpoints { target_port: Some(IntOrString::Int(EXT_PROC_METRICS_PORT as i32)), ..endpoint("/metrics") },
                    pm::PodMonitorPodMetricsEndpoints { port: Some("metrics".into()), metric_relabelings: Some(keep), ..endpoint("/stats/prometheus") },
                ]),
                ..Default::default()
            },
            status: None,
        })
    }

    /// The gateway's alerts, evaluated by the Project's Prometheus in each
    /// site: a model slow (95th percentile of the request duration, and of the
    /// time to first token when streamed) or failing, and the gateway's
    /// metrics gone.
    fn alert_rules(&self) -> Value {
        let a = &self.spec.alerts;
        let name = self.name;
        let sel = format!("namespace={},gateway={}", quote(self.ns), quote(name));
        let p95 = |metric: &str| format!("histogram_quantile(0.95, sum by (le, gen_ai_original_model) (rate({metric}_bucket{{{sel}}}[10m])))");
        let labels = Labels::from([("severity".to_string(), "warning".to_string()), ("gateway".to_string(), name.to_string())]);
        let alert = |rule: &str, r#for: &str, expr: String, summary: String| alert(rule, r#for, expr, &labels, summary);
        let model = "{{ $labels.gen_ai_original_model }}";
        let rules = vec![
            alert("BasisGatewaySlow", "15m", format!("{} > {}", p95("gen_ai_server_request_duration_seconds"), fmt_g(a.latency())),
                format!("Gateway {name}: 95% of {model} requests take up to {{{{ $value | humanizeDuration }}}} (threshold {}s)", fmt_g(a.latency()))),
            alert("BasisGatewaySlowFirstToken", "15m", format!("{} > {}", p95("gen_ai_server_time_to_first_token_seconds"), fmt_g(a.first_token())),
                format!(
                    "Gateway {name}: 95% of streamed {model} requests wait up to {{{{ $value | humanizeDuration }}}} for the first token (threshold {}s)",
                    fmt_g(a.first_token()))),
            alert("BasisGatewayErrors", "10m",
                format!(
                    "100 * sum by (gen_ai_original_model) (rate(gen_ai_server_request_duration_seconds_count{{{sel},error_type!=\"\"}}[10m]))\n  / sum by (gen_ai_original_model) (rate(gen_ai_server_request_duration_seconds_count{{{sel}}}[10m])) > {}",
                    fmt_g(a.error_percent())),
                format!("Gateway {name}: {{{{ $value | printf \"%.1f\" }}}}% of {model} requests fail (threshold {}%)", fmt_g(a.error_percent()))),
            alert("BasisGatewayMetricsMissing", "10m", format!("absent(up{{{sel}}})"),
                format!("Gateway {name}: no metrics from its proxies in this site")),
        ];
        to_value(&prometheus_rule(self.meta(&format!("{name}-gateway-alerts")), format!("gateway/{}/{name}", self.ns), rules))
    }

    /// The gateway's dashboard in the Project's Grafana (control plane):
    /// requests, errors, latency, time to first token and per output token,
    /// tokens, retries and rate-limited requests, per model and site.
    fn dashboard(&self) -> Value {
        let uid = format!("basis-gw-{}", &sha1hex(&format!("{}/{}", self.ns, self.name))[..12]);
        to_value(&scoped_dashboard(self.meta(&format!("{}-gateway", self.name)), self.ns, "Model gateways", uid.clone(), self.dashboard_json(&uid)))
    }

    fn dashboard_json(&self, uid: &str) -> String {
        let ds = json!({"type": "prometheus", "uid": "${datasource}"});
        let sel = format!("namespace={},gateway={},site=~\"$site\"", quote(self.ns), quote(self.name));
        let mut id = 0;
        let mut panel = |title: &str, unit: &str, x: i64, y: i64, w: i64, targets: Vec<Value>| {
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
                "gridPos": {"h": 8, "w": w, "x": x, "y": y}, "targets": ts,
                "fieldConfig": {"defaults": {"unit": unit}, "overrides": []}})
        };
        let q = |expr: String, legend: &str| json!({"expr": expr, "legendFormat": legend});
        let p = |quantile: &str, metric: &str| {
            format!("histogram_quantile({quantile}, sum by (le, gen_ai_original_model) (rate({metric}_bucket{{{sel}}}[$__rate_interval])))")
        };
        let rate = |metric: &str, extra: &str| format!("sum by (gen_ai_original_model) (rate({metric}{{{sel}{extra}}}[$__rate_interval]))");
        let count = "gen_ai_server_request_duration_seconds_count";
        let panels = vec![
            panel("Requests per second", "reqps", 0, 0, 12, vec![q(rate(count, ""), "{{gen_ai_original_model}}")]),
            panel("Failed requests", "percentunit", 12, 0, 12, vec![q(
                format!("{} / {}", rate(count, ",error_type!=\"\""), rate(count, "")), "{{gen_ai_original_model}}")]),
            panel("Request duration (p50, p95)", "s", 0, 8, 12, vec![
                q(p("0.5", "gen_ai_server_request_duration_seconds"), "p50 {{gen_ai_original_model}}"),
                q(p("0.95", "gen_ai_server_request_duration_seconds"), "p95 {{gen_ai_original_model}}"),
            ]),
            panel("Time to first token (p50, p95; streamed)", "s", 12, 8, 12, vec![
                q(p("0.5", "gen_ai_server_time_to_first_token_seconds"), "p50 {{gen_ai_original_model}}"),
                q(p("0.95", "gen_ai_server_time_to_first_token_seconds"), "p95 {{gen_ai_original_model}}"),
            ]),
            panel("Time per output token (p95; streamed)", "s", 0, 16, 12, vec![
                q(p("0.95", "gen_ai_server_time_per_output_token_seconds"), "{{gen_ai_original_model}}"),
            ]),
            panel("Tokens per second", "short", 12, 16, 12, vec![q(
                format!("sum by (gen_ai_original_model, gen_ai_token_type) (rate(gen_ai_client_token_usage_sum{{{sel}}}[$__rate_interval]))"),
                "{{gen_ai_original_model}} {{gen_ai_token_type}}")]),
            panel("Retries and fallbacks per second", "reqps", 0, 24, 12, vec![
                q(format!("sum by (model) (rate(envoy_cluster_upstream_rq_retry{{{sel}}}[$__rate_interval]))"), "retried {{model}}"),
                q(format!("sum by (model) (rate(envoy_cluster_upstream_rq_retry_success{{{sel}}}[$__rate_interval]))"), "recovered {{model}}"),
            ]),
            panel("Responses to clients", "reqps", 12, 24, 12, vec![
                q(format!("sum by (envoy_response_code_class) (rate(envoy_http_downstream_rq_xx{{{sel}}}[$__rate_interval]))"), "{{envoy_response_code_class}}xx"),
                q(format!("sum(rate(envoy_cluster_ratelimit_over_limit{{{sel}}}[$__rate_interval]))"), "rate limited"),
            ]),
        ];
        let d = json!({
            "uid": uid, "title": format!("Model gateway: {}", self.name), "schemaVersion": 39, "refresh": "1m",
            "time": {"from": "now-6h", "to": "now"}, "tags": ["basis", "gateway"],
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

/// The Envoy statistics the dashboard and alerts use; the rest (thousands of
/// series) isn't kept.
const ENVOY_METRICS: &str =
    "envoy_cluster_upstream_rq_(retry|retry_success|retry_overflow|xx|timeout)|envoy_http_downstream_rq_xx|envoy_cluster_ratelimit_over_limit";

/// What the Gateways buffer per request and response: prompts with context,
/// images and embeddings are large.
static BUFFER_LIMIT: std::sync::LazyLock<IntOrString> = std::sync::LazyLock::new(|| IntOrString::String("50Mi".into()));

/// A global rate limit rule: limit per unit, for a client (its header) or
/// the whole gateway, charged with cost (else 1 per request).
fn rate_rule(client: Option<&str>, limit: i64, unit: btp::BackendTrafficPolicyRateLimitGlobalRulesLimitUnit,
    cost: Option<btp::BackendTrafficPolicyRateLimitGlobalRulesCost>) -> btp::BackendTrafficPolicyRateLimitGlobalRules {
    btp::BackendTrafficPolicyRateLimitGlobalRules {
        client_selectors: client.map(|c| vec![btp::BackendTrafficPolicyRateLimitGlobalRulesClientSelectors {
            headers: Some(vec![btp::BackendTrafficPolicyRateLimitGlobalRulesClientSelectorsHeaders {
                name: CLIENT_HEADER.into(),
                r#type: Some(btp::BackendTrafficPolicyRateLimitGlobalRulesClientSelectorsHeadersType::Exact),
                value: Some(c.into()),
                invert: None,
            }]),
            ..Default::default()
        }]),
        limit: btp::BackendTrafficPolicyRateLimitGlobalRulesLimit { requests: limit, unit, from_metadata: None },
        cost,
        shared: Some(true),
        shadow_mode: None,
        x_rate_limit_headers: None,
    }
}

/// The gateway's access log: one JSON line per request with the client, the
/// model, its tokens and the outcome, never the prompt. The portal's Audit
/// logs page reads it (source "gateway").
fn telemetry() -> ep::EnvoyProxyTelemetry {
    let format = [
        ("basis", "gateway".to_string()),
        ("time", "%START_TIME%".into()),
        ("client", format!("%REQ({})%", CLIENT_HEADER.to_uppercase())),
        ("model", "%REQ(X-AI-EG-MODEL)%".into()),
        ("method", "%REQ(:METHOD)%".into()),
        ("path", "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%".into()),
        ("status", "%RESPONSE_CODE%".into()),
        ("details", "%RESPONSE_CODE_DETAILS%".into()),
        ("duration_ms", "%DURATION%".into()),
        ("input_tokens", "%DYNAMIC_METADATA(io.envoy.ai_gateway:llm_input_token)%".into()),
        ("output_tokens", "%DYNAMIC_METADATA(io.envoy.ai_gateway:llm_output_token)%".into()),
        ("total_tokens", "%DYNAMIC_METADATA(io.envoy.ai_gateway:llm_total_token)%".into()),
        ("request_id", "%REQ(X-REQUEST-ID)%".into()),
        ("source", "%DOWNSTREAM_REMOTE_ADDRESS_WITHOUT_PORT%".into()),
    ];
    ep::EnvoyProxyTelemetry {
        access_log: Some(ep::EnvoyProxyTelemetryAccessLog {
            settings: Some(vec![ep::EnvoyProxyTelemetryAccessLogSettings {
                format: Some(ep::EnvoyProxyTelemetryAccessLogSettingsFormat {
                    r#type: Some(ep::EnvoyProxyTelemetryAccessLogSettingsFormatType::Json),
                    json: Some(format.into_iter().map(|(k, v)| (k.to_string(), v)).collect()),
                    text: None,
                }),
                sinks: vec![ep::EnvoyProxyTelemetryAccessLogSettingsSinks {
                    r#type: Some(ep::EnvoyProxyTelemetryAccessLogSettingsSinksType::File),
                    file: Some(ep::EnvoyProxyTelemetryAccessLogSettingsSinksFile { path: Some("/dev/stdout".into()) }),
                    ..Default::default()
                }],
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::util::b64;
    use crate::common::util::{set_now, set_secret};

    const MODELS: &str = r#""models":[
        {"name":"gpt-4o-mini","endpoint":"https://api.openai.com/v1","apiKeySecretRef":{"name":"openai","key":"token"}},
        {"name":"claude","endpoint":"https://api.anthropic.com/v1","schema":"Anthropic","apiKeySecretRef":{"name":"anthropic"}},
        {"name":"llama","endpoint":"http://vllm.models.svc:8000/v1","upstreamModel":"meta-llama/Llama-3.1-8B-Instruct"}]"#;

    fn xr(spec: &str, status: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"ModelGateway","metadata":{{"name":"llm","namespace":"ai"}},"spec":{spec},"status":{status}}}"#
        )).unwrap()
    }

    fn required(recovery: bool) -> BTreeMap<String, Vec<Value>> {
        let mut locations = json!({"protected": "dc-a"});
        if recovery {
            locations["recovery"] = json!("dc-b");
        }
        BTreeMap::from([(REQUIRED_PROJECT.to_string(), vec![json!({"spec": {"locations": locations}})])])
    }

    fn run(xr: Value, observed: BTreeMap<String, Value>, required: BTreeMap<String, Vec<Value>>) -> Output {
        set_secret(Some("generated"));
        compose(&Input { xr, observed, required }).unwrap()
    }

    fn manifest(c: &Composed) -> &Value {
        &c.object["spec"]["forProvider"]["manifest"]
    }

    fn js(v: &Value) -> String {
        serde_json::to_string(v).unwrap()
    }

    fn id(model: &str) -> String {
        format!("model-{}", &sha1hex(model)[..8])
    }

    #[test]
    fn one_site_agent_router_in_the_protected_location() {
        let out = run(xr(&format!("{{{MODELS}}}"), "{}"), BTreeMap::new(), required(false));
        for key in ["keys", "protected-gateway", "protected-envoyproxy", "protected-keys", "protected-securitypolicy",
            "protected-clienttraffic", "protected-backendtraffic", "protected-route"] {
            assert!(out.composed.contains_key(key), "missing {key}");
        }
        assert_eq!(out.composed["protected-gateway"].object["spec"]["providerConfigRef"]["name"], "dc-a");
        // Images in requests and embeddings in responses: well over Envoy's defaults.
        assert_eq!(manifest(&out.composed["protected-clienttraffic"])["spec"]["http2"]["initialStreamWindowSize"], "50Mi");
        assert_eq!(manifest(&out.composed["protected-backendtraffic"])["spec"]["connection"]["bufferLimit"], "50Mi");
        assert_eq!(manifest(&out.composed["protected-envoyproxy"])["spec"]["provider"]["kubernetes"]["envoyService"]["name"], "llm");
        assert_eq!(out.status["endpoint"], "http://llm.ai.svc/v1");
        assert_eq!(out.status["keysSecret"], "llm-keys");
        assert_eq!(out.status["models"], 3);
    }

    #[test]
    fn a_key_per_client_kept_once_generated() {
        let observed = BTreeMap::from([("keys".to_string(), json!({"data": {"agent": b64("kept")}}))]);
        let out = run(xr(r#"{"clients":[{"name":"agent"},{"name":"chat"}]}"#, "{}"), observed, required(false));
        let data = out.composed["keys"].object["data"].as_object().unwrap();
        let dec = |k: &str| unb64(data[k].as_str().unwrap()).unwrap();
        assert_eq!(dec("agent"), "kept");
        assert_eq!(dec("chat"), "generated");
        assert_eq!(data.len(), 2);
        assert_eq!(out.status["clients"], 2);
    }

    #[test]
    fn models_route_backends_tls_for_https_provider_keys() {
        let out = run(xr(&format!("{{{MODELS}}}"), "{}"), BTreeMap::new(), required(false));
        let route = js(manifest(&out.composed["protected-route"]));
        assert!(route.contains(r#""value":"gpt-4o-mini""#) && route.contains(r#""modelNameOverride":"meta-llama/Llama-3.1-8B-Instruct""#), "route {route}");
        let (openai, claude, llama) = (id("gpt-4o-mini"), id("claude"), id("llama"));
        assert!(out.composed.contains_key(&format!("protected-{openai}-tls")), "no BackendTLSPolicy for the https endpoint");
        assert!(!out.composed.contains_key(&format!("protected-{llama}-tls")), "BackendTLSPolicy for a plain http endpoint");
        let backend = js(manifest(&out.composed[&format!("protected-{llama}-backend")]));
        assert!(backend.contains(r#""hostname":"vllm.models.svc","port":8000"#), "backend {backend}");
        assert_eq!(manifest(&out.composed[&format!("protected-{openai}-aiservicebackend")])["spec"]["schema"]["prefix"], "/v1");
        let refs = js(&out.composed[&format!("protected-{openai}-apikey")].object["spec"]["references"]);
        assert!(refs.contains(r#""fieldPath":"data.token""#) && refs.contains(r#""toFieldPath":"data.apiKey""#), "references {refs}");
        assert_eq!(manifest(&out.composed[&format!("protected-{claude}-backendsecurity")])["spec"]["type"], "AnthropicAPIKey");
        assert!(!out.composed.contains_key(&format!("protected-{llama}-apikey")), "api key copied for a model without one");
    }

    #[test]
    fn recovery_a_standby_the_active_site_gets_the_replicas() {
        let out = run(xr(r#"{"recovery":{"enabled":true},"activeSite":"recovery"}"#, "{}"), BTreeMap::new(), required(true));
        let replicas = |site: &str| manifest(&out.composed[&format!("{site}-envoyproxy")])["spec"]["provider"]["kubernetes"]["envoyDeployment"]["replicas"].clone();
        assert_eq!(replicas("recovery"), 2);
        assert_eq!(replicas("protected"), 1);
        assert_eq!(out.status["activeSite"], "recovery");
        assert_eq!(out.composed["recovery-gateway"].object["spec"]["providerConfigRef"]["name"], "dc-b");
    }

    #[test]
    fn a_stacks_gateway_carries_the_stacks_label() {
        let mut x = xr("{}", "{}");
        x["metadata"]["labels"] = json!({"ai.cndev.nl/genaistack": "bot"});
        let out = run(x, BTreeMap::new(), required(false));
        assert_eq!(out.composed["protected-gateway"].object["metadata"]["labels"]["ai.cndev.nl/genaistack"], "bot");
    }

    #[test]
    fn expose_an_https_gateway_of_its_own_on_a_load_balancer_the_internal_one_stays() {
        let spec = format!(r#"{{"expose":{{"enabled":true,"hostname":"llm.example.com","loadBalancerSourceRanges":["203.0.113.0/24"],
            "annotations":{{"lb.example/internal":"false"}}}},{MODELS}}}"#);
        let out = run(xr(&spec, "{}"), BTreeMap::new(), required(false));
        assert_eq!(manifest(&out.composed["protected-envoyproxy"])["spec"]["provider"]["kubernetes"]["envoyService"]["type"], "ClusterIP");
        let svc = js(&manifest(&out.composed["protected-external-envoyproxy"])["spec"]["provider"]["kubernetes"]["envoyService"]);
        for want in [r#""name":"llm-external""#, r#""type":"LoadBalancer""#, r#""loadBalancerSourceRanges":["203.0.113.0/24"]"#, r#""lb.example/internal":"false""#] {
            assert!(svc.contains(want), "external service {svc}");
        }
        let cert = js(&manifest(&out.composed["protected-certificate"])["spec"]);
        assert!(cert.contains(r#""dnsNames":["llm.example.com"]"#) && cert.contains(r#""kind":"ClusterIssuer","name":"basis""#), "certificate {cert}");
        let listeners = js(&manifest(&out.composed["protected-external-gateway"])["spec"]["listeners"]);
        assert!(listeners.contains(r#""protocol":"HTTPS""#) && !listeners.contains(r#""protocol":"HTTP""#) && listeners.contains(r#""name":"llm-tls""#),
            "external listeners {listeners}");
        for k in ["route", "securitypolicy", "clienttraffic", "backendtraffic"] {
            let refs = js(manifest(&out.composed[&format!("protected-{k}")]));
            assert!(refs.contains(r#""name":"llm-external""#), "{k} does not cover the external Gateway: {refs}");
        }
        assert_eq!(out.status["externalEndpoint"], "https://llm.example.com/v1");
        assert_eq!(out.status["endpoint"], "http://llm.ai.svc/v1");
    }

    #[test]
    fn expose_waits_for_the_certificate_and_the_address_then_reports_it() {
        let spec = r#"{"expose":{"enabled":true,"hostname":"llm.example.com","issuer":"acme","loadBalancerSourceRanges":["0.0.0.0/0"]}}"#;
        let live = |m: Value| json!({"status": {"atProvider": {"manifest": m}}});
        let cond = |t: &str| json!({"conditions": [{"type": t, "status": "True"}]});
        let mut observed = BTreeMap::from([("keys".to_string(), json!({}))]);
        for k in ["envoyproxy", "clienttraffic", "backendtraffic", "securitypolicy", "external-envoyproxy"] {
            observed.insert(format!("protected-{k}"), live(json!({"kind": "x"})));
        }
        observed.insert("protected-keys".into(), json!({"status": cond("Ready")}));
        observed.insert("protected-gateway".into(), live(json!({"status": cond("Programmed")})));
        let out = run(xr(spec, "{}"), observed.clone(), required(false));
        let msg = out.status["message"].as_str().unwrap();
        assert_eq!(out.status["ready"], false);
        assert!(msg.contains("ClusterIssuer acme") && msg.contains("LoadBalancer address in dc-a"), "message {msg}");
        observed.insert("protected-certificate".into(), live(json!({"status": cond("Ready")})));
        let mut gw = cond("Programmed");
        gw["addresses"] = json!([{"type": "IPAddress", "value": "198.51.100.7"}]);
        observed.insert("protected-external-gateway".into(), live(json!({"status": gw})));
        let out = run(xr(spec, "{}"), observed, required(false));
        assert_eq!(out.status["ready"], true);
        assert_eq!(out.status["sites"][0]["address"], "198.51.100.7");
    }

    #[test]
    fn recovery_in_a_project_without_a_recovery_location_says_so() {
        let out = run(xr(r#"{"recovery":{"enabled":true}}"#, "{}"), BTreeMap::new(), required(false));
        assert_eq!(out.status["ready"], false);
        assert!(out.status["message"].as_str().unwrap().contains("no recovery location"));
    }

    #[test]
    fn governance() {
        set_now(Some(chrono::DateTime::parse_from_rfc3339("2026-10-22T12:00:00Z").unwrap().into()));
        let spec = format!(r#"{{{MODELS},"monthlyTokens":5000000,"clients":[
            {{"name":"apps","monthlyTokens":1000000}},
            {{"name":"bot","owner":"team-ai","expiresAt":"2026-10-22"}},
            {{"name":"old","monthlyTokens":10,"expiresAt":"2026-10-21"}}]}}"#);
        let out = run(xr(&spec, "{}"), BTreeMap::new(), required(false));
        set_now(None);

        // A client past its last day loses its key; one on its last day keeps it.
        let keys = out.composed["keys"].object["data"].as_object().unwrap();
        assert!(!keys.contains_key("old") && keys.contains_key("bot"));
        assert_eq!(out.status["expiredClients"], json!(["old"]));

        // Who called goes upstream, each request's tokens into metadata.
        assert_eq!(manifest(&out.composed["protected-securitypolicy"])["spec"]["apiKeyAuth"]["forwardClientIDHeader"], CLIENT_HEADER);
        let costs = js(&manifest(&out.composed["protected-route"])["spec"]["llmRequestCosts"]);
        assert!(costs.contains(r#""metadataKey":"llm_total_token","type":"TotalToken""#), "request costs {costs}");

        // Monthly caps: apps, and the gateway as a whole; not the expired client.
        let limits = js(manifest(&out.composed["protected-ratelimit"]));
        for want in [
            r#""targetRefs":[{"group":"gateway.networking.k8s.io","kind":"HTTPRoute","name":"llm"}]"#,
            r#""mergeType":"StrategicMerge""#,
            r#"{"clientSelectors":[{"headers":[{"name":"x-basis-client","type":"Exact","value":"apps"}]}],"cost":"#,
            r#""limit":{"requests":1000000,"unit":"Month"}"#,
            r#""limit":{"requests":5000000,"unit":"Month"}"#,
            r#""response":{"from":"Metadata","metadata":{"key":"llm_total_token","namespace":"io.envoy.ai_gateway"}}"#,
        ] {
            assert!(limits.contains(want), "limits lack {want}\n{limits}");
        }
        assert!(!limits.contains(r#""value":"old""#), "a cap for an expired client");

        // Token metrics for the Project's cost, and an access log on each Gateway.
        let pm = js(manifest(&out.composed["protected-podmonitor"]));
        assert!(pm.contains(r#""values":["llm"]"#) && pm.contains(r#""targetPort":1064"#), "podmonitor {pm}");
        let log = js(&manifest(&out.composed["protected-envoyproxy"])["spec"]["telemetry"]);
        assert!(log.contains(r#""client":"%REQ(X-BASIS-CLIENT)%""#)
            && log.contains(r#""total_tokens":"%DYNAMIC_METADATA(io.envoy.ai_gateway:llm_total_token)%""#), "access log {log}");

        // No caps, no rate limit policy.
        let out = run(xr(&format!("{{{MODELS}}}"), "{}"), BTreeMap::new(), required(false));
        assert!(!out.composed.contains_key("protected-ratelimit"), "rate limits without monthlyTokens");
    }

    #[test]
    fn resilience() {
        let spec = r#"{"models":[
            {"name":"primary","endpoint":"https://api.openai.com/v1","upstreamModel":"gpt-4o","fallbacks":["backup","local","primary","nope"]},
            {"name":"backup","endpoint":"https://api.mistral.ai/v1","upstreamModel":"mistral-large"},
            {"name":"local","endpoint":"http://vllm.models.svc:8000/v1"}],
            "retry":{"attempts":2,"retryOn":[429,503],"perTryTimeout":"60s"},
            "rateLimit":{"requestsPerMinute":600},
            "clients":[{"name":"apps","tokensPerMinute":20000}],
            "alerts":{"latencySeconds":30}}"#;
        let out = run(xr(spec, "{}"), BTreeMap::new(), required(false));

        // A model's fallbacks, a priority each, with their own upstream names;
        // itself and unknown names skipped.
        let rules = manifest(&out.composed["protected-route"])["spec"]["rules"].as_array().unwrap();
        let primary = rules.iter().find(|r| r["matches"][0]["headers"][0]["value"] == "primary").unwrap();
        assert_eq!(js(&primary["backendRefs"]), format!(
            r#"[{{"modelNameOverride":"gpt-4o","name":"llm-{}"}},{{"modelNameOverride":"mistral-large","name":"llm-{}","priority":1}},{{"modelNameOverride":"local","name":"llm-{}","priority":2}}]"#,
            id("primary"), id("backup"), id("local")));

        // 2 attempts on each of 3 priorities: 5 retries, moving on after 2.
        let retry = js(&manifest(&out.composed["protected-backendtraffic"])["spec"]["retry"]);
        for want in [r#""numRetries":5"#, r#""numAttemptsPerPriority":2"#, r#""httpStatusCodes":[429,503]"#, r#""timeout":"60s""#] {
            assert!(retry.contains(want), "retry lacks {want}: {retry}");
        }
        // The buffers stay where they were.
        assert_eq!(manifest(&out.composed["protected-backendtraffic"])["spec"]["connection"]["bufferLimit"], "50Mi");

        // Per-minute caps: requests for the gateway, tokens for apps.
        let limits = js(manifest(&out.composed["protected-ratelimit"]));
        for want in [r#"{"limit":{"requests":600,"unit":"Minute"},"shared":true}"#, r#""limit":{"requests":20000,"unit":"Minute"}"#, r#""value":"apps""#] {
            assert!(limits.contains(want), "limits lack {want}: {limits}");
        }

        // Metrics labelled with gateway and model; alerts; the dashboard.
        let pm = js(manifest(&out.composed["protected-podmonitor"]));
        for want in [r#""targetLabel":"gateway""#, r#""port":"metrics","relabelings""#,
            r#""regex":"httproute/ai/llm/rule/0","replacement":"backup","sourceLabels":["envoy_cluster_name"],"targetLabel":"model""#] {
            assert!(pm.contains(want), "podmonitor lacks {want}: {pm}");
        }
        let slow = &manifest(&out.composed["protected-prometheusrule"])["spec"]["groups"][0]["rules"][0];
        assert!(slow["expr"].as_str().unwrap().ends_with(
            r#"rate(gen_ai_server_request_duration_seconds_bucket{namespace="ai",gateway="llm"}[10m]))) > 30"#), "latency alert {}", slow["expr"]);
        assert_eq!(out.composed["dashboard"].object["kind"], "GrafanaDashboard");
        assert!(out.composed["dashboard"].ready);

        // One attempt and no fallbacks: no retry; alerts off: no rule.
        let out = run(xr(&format!(r#"{{{MODELS},"retry":{{"attempts":1}},"alerts":{{"disabled":true}}}}"#), "{}"), BTreeMap::new(), required(false));
        assert!(manifest(&out.composed["protected-backendtraffic"])["spec"].get("retry").is_none());
        assert!(!out.composed.contains_key("protected-prometheusrule"), "alerts though disabled");
    }

    fn model_server(name: &str, spec: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"ModelServer","metadata":{{"name":"{name}","namespace":"ai"}},"spec":{spec}}}"#
        )).unwrap()
    }

    fn rules(out: &Output, site: &str) -> BTreeMap<String, Vec<Value>> {
        manifest(&out.composed[&format!("{site}-route")])["spec"]["rules"].as_array().unwrap().iter()
            .map(|r| (r["matches"][0]["headers"][0]["value"].as_str().unwrap().to_string(), r["backendRefs"].as_array().unwrap().clone()))
            .collect()
    }

    #[test]
    fn self_hosted_asks_for_the_model_servers_it_names() {
        let reqs = requirements(&Input {
            xr: xr(r#"{"models":[{"name":"llama","server":"llama"},{"name":"gpt","endpoint":"https://api.openai.com/v1"}]}"#, "{}"),
            ..Default::default()
        });
        let r = &reqs["server-llama"];
        assert_eq!((r.kind.as_str(), r.namespace.as_deref(), r.name.as_deref()), ("ModelServer", Some("ai"), Some("llama")));
        assert_eq!(reqs.len(), 2);
    }

    #[test]
    fn self_hosted_the_inference_pool_where_the_server_runs() {
        let mut req = required(true);
        req.insert("server-llama".into(), vec![model_server("llama", r#"{"model":{"uri":"hf://x/y"}}"#)]);
        let out = run(xr(r#"{"recovery":{"enabled":true},"models":[{"name":"llama","server":"llama"}]}"#, "{}"), BTreeMap::new(), req);
        let refs = &rules(&out, "protected")["llama"];
        assert_eq!(refs, &vec![json!({"group": "inference.networking.k8s.io", "kind": "InferencePool", "name": "llama-inference-pool"})]);
        for key in out.composed.keys() {
            assert!(!key.contains("-model-"), "{key}: no backend objects for a pool");
        }
        assert!(!out.composed.contains_key("recovery-route"), "the server doesn't run in the recovery site");
        assert!(out.status["message"].as_str().unwrap().contains("ModelServer llama doesn't run in the recovery site"));
    }

    #[test]
    fn self_hosted_the_service_another_served_name_fallbacks_no_prefix_cache_routing() {
        let mut req = required(false);
        req.insert("server-llama".into(), vec![model_server("llama", r#"{"model":{"uri":"hf://x/y","name":"meta-llama/Llama-3.1-8B-Instruct"}}"#)]);
        req.insert("server-qwen".into(), vec![model_server("qwen", r#"{"model":{"uri":"hf://x/q"},"routing":{"prefixCacheAware":false}}"#)]);
        req.insert("server-mistral".into(), vec![model_server("mistral", r#"{"model":{"uri":"hf://x/m"}}"#)]);
        let out = run(xr(r#"{"models":[{"name":"llama","server":"llama"},{"name":"qwen","server":"qwen"},
            {"name":"mistral","server":"mistral","fallbacks":["gpt"]},{"name":"gpt","endpoint":"https://api.openai.com/v1"}]}"#, "{}"), BTreeMap::new(), req);
        let got = rules(&out, "protected");
        assert!(got["llama"][0].get("kind").is_none(), "llama: the Service");
        assert_eq!(got["llama"][0]["modelNameOverride"], "meta-llama/Llama-3.1-8B-Instruct", "renamed");
        assert!(got["qwen"][0].get("kind").is_none(), "qwen: the Service");
        assert_eq!(got["mistral"].len(), 2, "mistral: the Service, then its fallback");
        assert!(got["mistral"][0].get("kind").is_none());
        let backend = manifest(&out.composed[&format!("protected-{}-backend", id("llama"))]);
        assert_eq!(backend["spec"]["endpoints"][0], json!({"fqdn": {"hostname": "llama-kserve-workload-svc.ai.svc", "port": 8000}}));
        assert!(!out.composed.contains_key(&format!("protected-{}-apikey", id("llama"))), "no provider key for a self-hosted model");
    }

    #[test]
    fn self_hosted_a_server_that_isnt_there_yet() {
        let out = run(xr(r#"{"models":[{"name":"llama","server":"llama"}]}"#, "{}"), BTreeMap::new(), required(false));
        assert_eq!(rules(&out, "protected")["llama"][0]["kind"], "InferencePool", "unresolved: routed to the pool it will have");
        assert!(!out.status["message"].as_str().unwrap().contains("llama"), "no note");
        let mut req = required(false);
        req.insert("server-llama".into(), vec![]);
        let out = run(xr(r#"{"models":[{"name":"llama","server":"llama"}]}"#, "{}"), BTreeMap::new(), req);
        assert!(out.status["message"].as_str().unwrap().contains("no ModelServer llama in ai"));
    }

    #[test]
    fn parses_endpoints_like_go() {
        let u = parse_url("https://api.openai.com/v1/").unwrap();
        assert_eq!((u.scheme.as_str(), u.hostname.as_str(), u.port.as_str(), u.path.as_str()), ("https", "api.openai.com", "", "/v1/"));
        let u = parse_url("http://vllm.models.svc:8000/v1?x=1").unwrap();
        assert_eq!((u.hostname.as_str(), u.port.as_str(), u.path.as_str()), ("vllm.models.svc", "8000", "/v1"));
        assert!(parse_url("not a url").is_none());
        let err = compose(&Input { xr: xr(r#"{"models":[{"name":"x","endpoint":"nope"}]}"#, "{}"), required: required(false), ..Default::default() });
        assert_eq!(err.unwrap_err(), r#"model "x": endpoint "nope" is not a URL"#);
    }
}
