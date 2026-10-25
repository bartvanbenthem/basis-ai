//! Composes a GenAIStack (ai.cndev.nl/v1alpha1): the platform side of a
//! generative AI service in a Project, in its protected site and optionally a
//! warm standby in its recovery site.
//!
//! On the control plane, next to the XR, labelled ai.cndev.nl/genaistack:
//! <name>, which the admission policy reads to keep them the stack's:
//!
//!     database           PostgresCluster <name>-db: profile vector, PostgreSQL 18,
//!                        the stack's own role <name>_stack (member of the
//!                        database owner), geo-replicated with recovery, its
//!                        primary site spec.recovery.activeSite
//!     db-credentials     Secret <name>-db-credentials (basic-auth) for that role:
//!                        generated once, then kept; the PostgresCluster copies it
//!                        to its locations, so the stack knows the password
//!     cache, cache-dr    ValkeyCache <name>-cache (protected) and <name>-cache-dr
//!                        (recovery): one node each, so plain clients work
//!     gateway            ModelGateway <name>-gateway (client "apps"), unless
//!                        spec.gateway.ref names one to share (client
//!                        spec.gateway.client, the stack's name by default)
//!
//! spec.retrieval.expose and spec.gateway.expose go to the database's and the
//! gateway's spec.expose: a LoadBalancer for clients outside the location.
//!
//!     connection-<site>  Secret <name>-connection-<site>: the site's wiring
//!
//! In each site's location (a provider-kubernetes Object, prefix "<site>-"):
//!
//!     connection         Secret <name>-connection, data from connection-<site>
//!
//! Active site: where the database's primary runs (its status.primarySite).
//! It gets the full-size cache and gateway, the standby site a small cache and
//! a minimal gateway, so a switchover of the database moves the stack along.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::common::lenient::decode;
use crate::common::util::{as_str, b64, condition_true, dig_opt, labels_obj, new_secret, or, or_i, unb64};
use crate::common::{Composed, Condition, Input, Output, Requirement, Result};
use crate::lenient;

// Requirement names.
pub const REQUIRED_PROJECT: &str = "project";
pub const REQUIRED_CACHE_SECRET: &str = "cache-secret";
pub const REQUIRED_DR_CACHE_SECRET: &str = "cache-dr-secret";
pub const REQUIRED_GATEWAY_KEYS: &str = "gateway-keys";
pub const REQUIRED_GATEWAY: &str = "gateway";

/// Marks what a stack composes next to it as the stack's.
pub const OWNER_LABEL: &str = "ai.cndev.nl/genaistack";

pub const SITE_PROTECTED: &str = "protected";
pub const SITE_RECOVERY: &str = "recovery";

lenient! {
    pub struct Metadata { pub name: String, pub namespace: String }
}
lenient! {
    pub struct SiteRef { pub site: String, pub location: String }
}
lenient! {
    pub struct XrStatus { pub sites: Vec<SiteRef> }
}
lenient! {
    /// The GenAIStack XR, as far as the composition reads it. Fields mirror
    /// apis/genaistack/definition.yaml; the accessors repeat the XRD defaults
    /// so `crossplane render` and older objects come out the same.
    pub struct Xr { pub metadata: Metadata, pub spec: Spec, pub status: XrStatus }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct RecoverySpec {
        pub enabled: bool,
        pub active_site: String,
        pub promotion: String,
        pub cache_memory: String,
        pub gateway_replicas: Option<i64>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Retrieval {
        pub size: String,
        pub instances: i64,
        pub storage_size: String,
        pub backup: bool,
        pub extensions: Option<Vec<String>>,
        /// pgaudit.log for the database; empty, no audit logging.
        pub audit_log: String,
        /// Goes to the PostgresCluster's spec.expose as it is.
        pub expose: Map<String, Value>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Cache {
        pub enabled: Option<bool>,
        pub mode: String,
        pub cpu: String,
        pub memory: String,
        pub eviction_policy: String,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Gateway {
        pub enabled: Option<bool>,
        pub replicas: i64,
        /// Go to the stack's own ModelGateway as they are.
        pub models: Option<Vec<Value>>,
        /// A ModelGateway in the namespace to use instead of one of the
        /// stack's own; client is the stack's client there.
        #[serde(rename = "ref")]
        pub reference: String,
        pub client: String,
        pub expose: Map<String, Value>,
        pub monthly_tokens: i64,
        pub retry: Map<String, Value>,
        pub rate_limit: Map<String, Value>,
        pub alerts: Map<String, Value>,
    }
}
lenient! {
    pub struct Spec { pub recovery: RecoverySpec, pub retrieval: Retrieval, pub cache: Cache, pub gateway: Gateway }
}

impl Spec {
    fn cache_enabled(&self) -> bool {
        self.cache.enabled.unwrap_or(true)
    }
    fn gateway_enabled(&self) -> bool {
        self.gateway.enabled.unwrap_or(true)
    }
    fn cache_mode(&self) -> &str {
        or(&self.cache.mode, "semantic")
    }
    fn cache_cpu(&self) -> &str {
        or(&self.cache.cpu, "500m")
    }
    fn cache_memory(&self) -> &str {
        or(&self.cache.memory, "1Gi")
    }
    fn standby_memory(&self) -> &str {
        or(&self.recovery.cache_memory, "512Mi")
    }
    fn eviction(&self) -> &str {
        or(&self.cache.eviction_policy, "allkeys-lru")
    }
    fn gateway_replicas(&self) -> i64 {
        or_i(self.gateway.replicas, 2)
    }
    fn primary_site(&self) -> &str {
        or(&self.recovery.active_site, SITE_PROTECTED)
    }
    fn instances(&self) -> i64 {
        or_i(self.retrieval.instances, 3)
    }
    fn storage_size(&self) -> &str {
        or(&self.retrieval.storage_size, "20Gi")
    }
    fn standby_gateway_replicas(&self) -> i64 {
        self.recovery.gateway_replicas.unwrap_or(1)
    }
    fn extensions(&self) -> Vec<String> {
        self.retrieval.extensions.clone().unwrap_or_else(|| vec!["vector".into()])
    }
    /// The ModelGateway the stack uses and its client there: its own
    /// <name>-gateway (client apps), or spec.gateway.ref.
    fn gateway(&self, stack: &str) -> (String, String, bool) {
        if !self.gateway.reference.is_empty() {
            return (self.gateway.reference.clone(), or(&self.gateway.client, stack).to_string(), false);
        }
        (format!("{stack}-gateway"), "apps".into(), true)
    }
}

/// The Project (its sites), the caches' password Secrets, the gateway's
/// keys and, for a shared gateway, the ModelGateway itself.
pub fn requirements(input: &Input) -> BTreeMap<String, Requirement> {
    let x: Xr = decode(&input.xr);
    let (ns, name) = (x.metadata.namespace.as_str(), x.metadata.name.as_str());
    let mut reqs = BTreeMap::from([
        (REQUIRED_PROJECT.to_string(), Requirement::named("platform.cndev.nl/v1alpha1", "Project", "", ns)),
        (REQUIRED_CACHE_SECRET.to_string(), Requirement::named("v1", "Secret", ns, &format!("{name}-cache-valkey"))),
        (REQUIRED_DR_CACHE_SECRET.to_string(), Requirement::named("v1", "Secret", ns, &format!("{name}-cache-dr-valkey"))),
    ]);
    if x.spec.gateway_enabled() {
        let (gw, _, own) = x.spec.gateway(name);
        reqs.insert(REQUIRED_GATEWAY_KEYS.into(), Requirement::named("v1", "Secret", ns, &format!("{gw}-keys")));
        if !own {
            reqs.insert(REQUIRED_GATEWAY.into(), Requirement::named("ai.cndev.nl/v1alpha1", "ModelGateway", ns, &gw));
        }
    }
    reqs
}

/// One of the stack's sites in this reconcile.
struct Site {
    name: &'static str,
    location: String,
    active: bool,
    /// The site's ValkeyCache, and the requirement name of its password Secret.
    cache: String,
    cache_secret: &'static str,
}

/// Renders the desired state of a GenAIStack.
pub fn compose(input: &Input) -> Result<Output> {
    let xr: Xr = decode(&input.xr);
    let (name, ns) = (xr.metadata.name.as_str(), xr.metadata.namespace.as_str());
    let spec = &xr.spec;
    let labels = labels_obj(&[
        ("app.kubernetes.io/managed-by", "crossplane"),
        ("app.kubernetes.io/part-of", "basis"),
        (OWNER_LABEL, name),
    ]);
    let meta = |n: &str| json!({"name": n, "namespace": ns, "labels": labels});
    let observed = &input.observed;
    let mut out = Output::default();

    // ---- sites: pinned in status.sites, else the Project's locations
    let project = input.first(REQUIRED_PROJECT);
    let pinned: BTreeMap<&str, &str> = xr.status.sites.iter().map(|s| (s.site.as_str(), s.location.as_str())).collect();
    let location = |s: &str| -> String {
        or(pinned.get(s).copied().unwrap_or(""), as_str(dig_opt(project, &["spec", "locations", s]))).to_string()
    };
    // The active site follows the database's primary.
    let mut active = SITE_PROTECTED;
    if as_str(dig_opt(observed.get("database"), &["status", "primarySite"])) == SITE_RECOVERY && spec.recovery.enabled {
        active = SITE_RECOVERY;
    }
    let mut sites = vec![Site { name: SITE_PROTECTED, location: location(SITE_PROTECTED), active: false,
        cache: format!("{name}-cache"), cache_secret: REQUIRED_CACHE_SECRET }];
    if spec.recovery.enabled {
        sites.push(Site { name: SITE_RECOVERY, location: location(SITE_RECOVERY), active: false,
            cache: format!("{name}-cache-dr"), cache_secret: REQUIRED_DR_CACHE_SECRET });
    }
    for s in &mut sites {
        s.active = s.name == active;
    }

    // ---- control plane: credentials, the child APIs
    let mut problems: Vec<String> = vec![];
    let role = format!("{}_stack", name.replace('-', "_"));
    let db_password = keep(observed, "db-credentials", "password");
    out.composed.insert("db-credentials".into(), Composed { ready: observed.contains_key("db-credentials"), object: json!({
        "apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/basic-auth",
        "metadata": meta(&format!("{name}-db-credentials")),
        "data": {"username": b64(&role), "password": b64(&db_password)},
    })});

    let backup = spec.retrieval.backup || spec.recovery.enabled;
    let mut geo = json!({"enabled": spec.recovery.enabled, "primarySite": SITE_PROTECTED});
    if spec.recovery.enabled {
        // The stack's switchover: the database moves its primary, the stack
        // follows once it has (status.primarySite).
        geo["primarySite"] = json!(spec.primary_site());
        if !spec.recovery.promotion.is_empty() {
            geo["promotion"] = json!(spec.recovery.promotion);
        }
    }
    let mut db_spec = json!({
        "profile": "vector",
        "postgresVersion": 18,
        "instances": spec.instances(),
        "storage": {"size": spec.storage_size()},
        "database": {"extensions": spec.extensions()},
        "roles": [{"name": role, "passwordSecret": format!("{name}-db-credentials"), "inRoles": ["app"]}],
        "backup": {"enabled": backup},
        "geoReplication": geo,
    });
    if !spec.retrieval.size.is_empty() {
        db_spec["size"] = json!(spec.retrieval.size);
    }
    if !spec.retrieval.expose.is_empty() {
        db_spec["expose"] = json!(spec.retrieval.expose);
    }
    // pgaudit: setting pgaudit.log is what loads it (the PostgresCluster's
    // spec.postgresql.parameters, as a standalone cluster does it).
    let audit = spec.retrieval.audit_log.trim();
    if !audit.is_empty() {
        db_spec["postgresql"] = json!({"parameters": {"pgaudit.log": audit}});
    }
    let db_ready = condition_true(observed.get("database"), "Ready");
    out.composed.insert("database".into(), Composed { ready: db_ready, object: json!({
        "apiVersion": "postgres.cndev.nl/v1alpha1", "kind": "PostgresCluster",
        "metadata": meta(&format!("{name}-db")), "spec": db_spec,
    })});
    if spec.cache_enabled() {
        for s in &sites {
            let memory = if s.active { spec.cache_memory() } else { spec.standby_memory() };
            let key = if s.name == SITE_RECOVERY { "cache-dr" } else { "cache" };
            out.composed.insert(key.into(), Composed { ready: condition_true(observed.get(key), "Ready"), object: json!({
                "apiVersion": "cache.cndev.nl/v1alpha1", "kind": "ValkeyCache",
                "metadata": meta(&s.cache),
                "spec": {
                    "site": s.name, "mode": spec.cache_mode(),
                    // One node: the Service always reaches the primary, so clients
                    // without cluster support work too.
                    "shards": 1, "replicas": 0,
                    "resources": {"cpu": spec.cache_cpu(), "memory": memory},
                    "evictionPolicy": spec.eviction(),
                },
            })});
        }
    }

    // ---- the gateway: the stack's own ModelGateway, or a shared one
    let mut components = json!({"database": format!("{name}-db")});
    let mut models = 0i64;
    let mut gateway_external = String::new();
    let mut gateway_key = String::new();
    let mut gateway_ready = true;
    let (gw_name, client, own) = spec.gateway(name);
    if spec.gateway_enabled() {
        components["gateway"] = json!(gw_name);
        if own {
            models = spec.gateway.models.as_ref().map_or(0, |m| m.len() as i64);
            let mut gw_spec = json!({
                "replicas": spec.gateway_replicas(),
                "recovery": {"enabled": spec.recovery.enabled, "replicas": spec.standby_gateway_replicas()},
                "activeSite": active,
                "clients": [{"name": client}],
                "models": spec.gateway.models.clone().unwrap_or_default(),
            });
            if !spec.gateway.expose.is_empty() {
                gw_spec["expose"] = json!(spec.gateway.expose);
            }
            if spec.gateway.monthly_tokens > 0 {
                gw_spec["monthlyTokens"] = json!(spec.gateway.monthly_tokens);
            }
            for (k, v) in [("retry", &spec.gateway.retry), ("rateLimit", &spec.gateway.rate_limit), ("alerts", &spec.gateway.alerts)] {
                if !v.is_empty() {
                    gw_spec[k] = json!(v);
                }
            }
            gateway_ready = condition_true(observed.get("gateway"), "Ready");
            out.composed.insert("gateway".into(), Composed { ready: gateway_ready, object: json!({
                "apiVersion": "ai.cndev.nl/v1alpha1", "kind": "ModelGateway",
                "metadata": meta(&gw_name), "spec": gw_spec,
            })});
            gateway_external = as_str(dig_opt(observed.get("gateway"), &["status", "externalEndpoint"])).to_string();
        } else {
            let gw = input.first(REQUIRED_GATEWAY);
            models = dig_opt(gw, &["status", "models"]).and_then(Value::as_f64).unwrap_or(0.0) as i64;
            gateway_external = as_str(dig_opt(gw, &["status", "externalEndpoint"])).to_string();
            gateway_ready = gw.is_some() && condition_true(gw, "Ready");
            if gw.is_none() {
                problems.push(format!("no ModelGateway {gw_name} in namespace {ns} (spec.gateway.ref)"));
            } else if spec.recovery.enabled && dig_opt(gw, &["spec", "recovery", "enabled"]) != Some(&json!(true)) {
                problems.push(format!("ModelGateway {gw_name} has no recovery site; set its spec.recovery.enabled"));
            }
        }
        gateway_key = required_secret(input, REQUIRED_GATEWAY_KEYS, &client);
        if gateway_key.is_empty() {
            if own {
                problems.push(format!("waiting for ModelGateway {gw_name}'s key"));
            } else {
                problems.push(format!("ModelGateway {gw_name} has no client {client}; add it to its spec.clients"));
            }
        }
    }

    // ---- each site: the wiring in its location
    if spec.cache_enabled() {
        components["cache"] = json!(format!("{name}-cache"));
        if spec.recovery.enabled {
            components["recoveryCache"] = json!(format!("{name}-cache-dr"));
        }
    }
    let db_host = format!("{name}-db-rw.{ns}.svc");
    let gateway_endpoint = format!("http://{gw_name}.{ns}.svc/v1");
    let mut all_ready = db_ready && gateway_ready;
    let mut site_status = vec![];
    for s in &sites {
        let mut ss = json!({"site": s.name, "location": s.location, "active": s.active, "databaseEndpoint": format!("{db_host}:5432")});
        if s.location.is_empty() {
            problems.push(format!("Project {ns} has no {0} location (spec.locations.{0})", s.name));
            site_status.push(ss);
            all_ready = false;
            continue;
        }
        let mut conn: BTreeMap<&str, String> = BTreeMap::from([
            ("SITE", s.name.to_string()),
            ("ACTIVE", s.active.to_string()),
            ("DATABASE_HOST", db_host.clone()),
            ("DATABASE_PORT", "5432".into()),
            ("DATABASE_NAME", "app".into()),
            ("DATABASE_USER", role.clone()),
            ("DATABASE_PASSWORD", db_password.clone()),
            ("DATABASE_URL", format!("postgresql://{role}:{}@{db_host}:5432/app", query_escape(&db_password))),
        ]);
        if spec.cache_enabled() {
            ss["cacheEndpoint"] = json!(format!("valkey-{}.{ns}.svc:6379", s.cache));
            let pw = required_secret(input, s.cache_secret, "password");
            if !pw.is_empty() {
                let host = format!("valkey-{}.{ns}.svc", s.cache);
                conn.insert("VALKEY_URL", format!("valkey://default:{pw}@{host}:6379"));
                conn.insert("VALKEY_HOST", host);
                conn.insert("VALKEY_PORT", "6379".into());
                conn.insert("VALKEY_PASSWORD", pw);
                conn.insert("VALKEY_CLUSTER", "false".into());
            } else {
                problems.push(format!("waiting for cache {}'s password", s.cache));
                all_ready = false;
            }
        }
        if spec.gateway_enabled() {
            ss["gatewayEndpoint"] = json!(gateway_endpoint);
            if !gateway_key.is_empty() {
                conn.insert("OPENAI_BASE_URL", gateway_endpoint.clone());
                conn.insert("OPENAI_API_KEY", gateway_key.clone());
            }
        }
        let data: Map<String, Value> = conn.iter().map(|(k, v)| (k.to_string(), json!(b64(v)))).collect();
        let conn_key = format!("connection-{}", s.name);
        out.composed.insert(conn_key.clone(), Composed { ready: observed.contains_key(&conn_key), object: json!({
            "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": meta(&format!("{name}-connection-{}", s.name)), "data": data,
        })});

        let k = format!("{}-connection", s.name);
        // The Secret's data comes from the control plane, never through this spec.
        let refs: Vec<Value> = ["data", "type"].iter().map(|f| json!({"patchesFrom": {"apiVersion": "v1", "kind": "Secret",
            "name": format!("{name}-connection-{}", s.name), "namespace": ns, "fieldPath": f}})).collect();
        let ready = condition_true(observed.get(&k), "Ready");
        out.composed.insert(k.clone(), Composed { ready, object: json!({
            "apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
            "metadata": {"name": format!("{name}-{k}"), "namespace": ns, "labels": labels,
                "annotations": {"platform.cndev.nl/location": s.location}},
            "spec": {
                "providerConfigRef": {"kind": "ClusterProviderConfig", "name": s.location},
                "watch": true,
                "forProvider": {"manifest": {"apiVersion": "v1", "kind": "Secret", "metadata": meta(&format!("{name}-connection"))}},
                "references": refs,
            },
        })});
        all_ready = all_ready && ready;
        site_status.push(ss);
    }
    for key in ["cache", "cache-dr", "db-credentials"] {
        if let Some(r) = out.composed.get(key) {
            all_ready = all_ready && r.ready;
        }
    }
    all_ready = all_ready && problems.is_empty();

    let mut status = json!({"ready": all_ready, "message": "", "activeSite": active, "models": models,
        "connectionSecret": format!("{name}-connection"), "components": components, "sites": site_status});
    if !gateway_external.is_empty() {
        status["gatewayExternalEndpoint"] = json!(gateway_external);
    }
    let mut cond = Condition { status: all_ready, reason: "Available".into(), message: String::new() };
    let msg = if !problems.is_empty() {
        cond.reason = "Waiting".into();
        problems.join("; ")
    } else if !db_ready {
        cond.reason = "Creating".into();
        format!("Waiting for PostgresCluster {name}-db")
    } else if spec.recovery.enabled && spec.primary_site() != active {
        cond.reason = "Switching".into();
        format!("Switching the active site to {}: waiting for PostgresCluster {name}-db", spec.primary_site())
    } else if !all_ready {
        cond.reason = "Creating".into();
        "Waiting for the cache and gateway".into()
    } else {
        format!("Stack {name} is ready; active site {active}")
    };
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

/// A field of a required Secret, "" until it exists.
fn required_secret(input: &Input, requirement: &str, field: &str) -> String {
    unb64(as_str(dig_opt(input.first(requirement), &["data", field]))).unwrap_or_default()
}

/// url.QueryEscape: what a password needs in a URL.
fn query_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::util::set_secret;

    const MODELS: &str = r#""gateway":{"models":[
        {"name":"gpt-4o-mini","endpoint":"https://api.openai.com/v1","apiKeySecretRef":{"name":"openai","key":"token"}},
        {"name":"llama","endpoint":"http://vllm.models.svc:8000/v1","upstreamModel":"meta-llama/Llama-3.1-8B-Instruct"}]}"#;

    fn xr(spec: &str, status: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"GenAIStack","metadata":{{"name":"bot","namespace":"ai"}},"spec":{spec},"status":{status}}}"#
        )).unwrap()
    }

    fn required(recovery: bool, caches: &[&str]) -> BTreeMap<String, Vec<Value>> {
        let mut locations = json!({"protected": "dc-a"});
        if recovery {
            locations["recovery"] = json!("dc-b");
        }
        let mut r = BTreeMap::from([
            (REQUIRED_PROJECT.to_string(), vec![json!({"spec": {"locations": locations}})]),
            (REQUIRED_CACHE_SECRET.to_string(), vec![]),
            (REQUIRED_DR_CACHE_SECRET.to_string(), vec![]),
            (REQUIRED_GATEWAY_KEYS.to_string(), vec![json!({"data": {"apps": b64("gwkey")}})]),
        ]);
        for c in caches {
            r.insert(c.to_string(), vec![json!({"data": {"password": b64("cachepw")}})]);
        }
        r
    }

    fn input(xr: Value, observed: &[(&str, Value)], required: BTreeMap<String, Vec<Value>>) -> Input {
        set_secret(Some("generated"));
        Input { xr, observed: observed.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(), required }
    }

    fn secret_data(c: &Composed) -> BTreeMap<String, String> {
        c.object["data"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), unb64(v.as_str().unwrap()).unwrap())).collect()
    }

    #[test]
    fn single_site_database_cache_gateway_and_wiring_in_the_protected_location() {
        let out = compose(&input(xr(&format!("{{{MODELS}}}"), "{}"), &[], required(false, &[REQUIRED_CACHE_SECRET]))).unwrap();
        for key in ["database", "db-credentials", "cache", "gateway", "connection-protected", "protected-connection"] {
            assert!(out.composed.contains_key(key), "missing {key}");
        }
        for key in ["cache-dr", "connection-recovery", "recovery-connection"] {
            assert!(!out.composed.contains_key(key), "{key} composed without recovery");
        }
        let db = &out.composed["database"].object["spec"];
        assert_eq!(db["profile"], "vector");
        assert_eq!(db["postgresVersion"], 18);
        assert_eq!(db["geoReplication"]["enabled"], false);
        let conn = secret_data(&out.composed["connection-protected"]);
        assert_eq!(conn["DATABASE_URL"], "postgresql://bot_stack:generated@bot-db-rw.ai.svc:5432/app");
        assert_eq!(conn["VALKEY_URL"], "valkey://default:cachepw@valkey-bot-cache.ai.svc:6379");
        assert_eq!(conn["OPENAI_BASE_URL"], "http://bot-gateway.ai.svc/v1");
        assert_eq!(conn["OPENAI_API_KEY"], "gwkey");
        assert_eq!(conn["ACTIVE"], "true");
        assert_eq!(conn["VALKEY_CLUSTER"], "false");
        assert_eq!(out.composed["protected-connection"].object["spec"]["providerConfigRef"]["name"], "dc-a");
        let gw = &out.composed["gateway"].object;
        assert_eq!(gw["kind"], "ModelGateway");
        assert_eq!(gw["metadata"]["name"], "bot-gateway");
        assert_eq!(gw["spec"]["models"].as_array().unwrap().len(), 2);
        assert_eq!(gw["metadata"]["labels"][OWNER_LABEL], "bot");
        assert_eq!(out.status["activeSite"], "protected");
        assert_eq!(out.status["models"], 2);
        assert_eq!(out.status["sites"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_shared_gateway_the_stacks_client_key_no_gateway_of_its_own() {
        let mut req = required(false, &[REQUIRED_CACHE_SECRET]);
        req.insert(REQUIRED_GATEWAY.into(), vec![json!({"spec": {}, "status": {"models": 4.0,
            "conditions": [{"type": "Ready", "status": "True"}]}})]);
        req.insert(REQUIRED_GATEWAY_KEYS.into(), vec![json!({"data": {"bot": b64("botkey")}})]);
        let out = compose(&input(xr(r#"{"gateway":{"ref":"shared"}}"#, "{}"), &[], req.clone())).unwrap();
        assert!(!out.composed.contains_key("gateway"), "composed a gateway next to the shared one");
        let conn = secret_data(&out.composed["connection-protected"]);
        assert_eq!(conn["OPENAI_BASE_URL"], "http://shared.ai.svc/v1");
        assert_eq!(conn["OPENAI_API_KEY"], "botkey");
        assert_eq!(out.status["models"], 4);

        // Without a key for the stack's client it says what to do.
        req.insert(REQUIRED_GATEWAY_KEYS.into(), vec![json!({"data": {}})]);
        let out = compose(&input(xr(r#"{"gateway":{"ref":"shared"}}"#, "{}"), &[], req)).unwrap();
        assert_eq!(out.status["ready"], false);
        assert!(out.status["message"].as_str().unwrap().contains("ModelGateway shared has no client bot"));
    }

    #[test]
    fn the_stacks_switchover_goes_to_the_database() {
        let out = compose(&input(xr(r#"{"recovery":{"enabled":true,"activeSite":"recovery","promotion":"Failover"}}"#, "{}"), &[],
            required(true, &[REQUIRED_CACHE_SECRET, REQUIRED_DR_CACHE_SECRET]))).unwrap();
        let geo = &out.composed["database"].object["spec"]["geoReplication"];
        assert_eq!(geo["primarySite"], "recovery");
        assert_eq!(geo["promotion"], "Failover");
        // Until the database has moved, protected stays active.
        assert_eq!(out.status["activeSite"], "protected");
        assert_eq!(out.composed["gateway"].object["spec"]["activeSite"], "protected");
    }

    #[test]
    fn recovery_warm_standby_the_stack_follows_the_databases_primary() {
        let spec = format!(r#"{{"recovery":{{"enabled":true}},{MODELS}}}"#);
        let req = || required(true, &[REQUIRED_CACHE_SECRET, REQUIRED_DR_CACHE_SECRET]);
        let out = compose(&input(xr(&spec, "{}"), &[], req())).unwrap();
        let db = &out.composed["database"].object["spec"];
        assert_eq!(db["geoReplication"]["enabled"], true);
        assert_eq!(db["backup"]["enabled"], true);
        assert_eq!(out.composed["cache"].object["spec"]["resources"]["memory"], "1Gi");
        assert_eq!(out.composed["cache-dr"].object["spec"]["resources"]["memory"], "512Mi");
        assert_eq!(out.composed["gateway"].object["spec"]["recovery"], json!({"enabled": true, "replicas": 1}));
        let conn = secret_data(&out.composed["connection-recovery"]);
        assert_eq!(conn["ACTIVE"], "false");
        assert!(conn["VALKEY_URL"].contains("valkey-bot-cache-dr.ai.svc"));

        // After a switchover of the database the recovery site is active.
        let observed = [("database", json!({"status": {"primarySite": "recovery"}}))];
        let out = compose(&input(xr(&spec, "{}"), &observed, req())).unwrap();
        assert_eq!(out.status["activeSite"], "recovery");
        assert_eq!(out.composed["cache-dr"].object["spec"]["resources"]["memory"], "1Gi");
        assert_eq!(out.composed["gateway"].object["spec"]["activeSite"], "recovery");
    }

    #[test]
    fn a_recovery_stack_in_a_project_without_a_recovery_location_says_so() {
        let out = compose(&input(xr(r#"{"recovery":{"enabled":true}}"#, "{}"), &[], required(false, &[]))).unwrap();
        assert_eq!(out.status["ready"], false);
        assert!(out.status["message"].as_str().unwrap().contains("no recovery location"));
    }

    #[test]
    fn keeps_generated_credentials() {
        let observed = [("db-credentials", json!({"data": {"password": b64("kept")}}))];
        let out = compose(&input(xr("{}", "{}"), &observed, required(false, &[REQUIRED_CACHE_SECRET]))).unwrap();
        assert_eq!(secret_data(&out.composed["connection-protected"])["DATABASE_PASSWORD"], "kept");
    }

    #[test]
    fn expose_goes_to_the_database_and_the_gateway_the_connection_stays_internal() {
        let spec = r#"{"retrieval":{"expose":{"enabled":true,"loadBalancerSourceRanges":["10.0.0.0/8"]}},
            "gateway":{"expose":{"enabled":true,"hostname":"bot.example.com","loadBalancerSourceRanges":["0.0.0.0/0"]}}}"#;
        let observed = [("gateway", json!({"status": {"externalEndpoint": "https://bot.example.com/v1"}}))];
        let out = compose(&input(xr(spec, "{}"), &observed, required(false, &[REQUIRED_CACHE_SECRET]))).unwrap();
        assert_eq!(out.composed["database"].object["spec"]["expose"], json!({"enabled": true, "loadBalancerSourceRanges": ["10.0.0.0/8"]}));
        assert_eq!(out.composed["gateway"].object["spec"]["expose"],
            json!({"enabled": true, "hostname": "bot.example.com", "loadBalancerSourceRanges": ["0.0.0.0/0"]}));
        assert_eq!(out.status["gatewayExternalEndpoint"], "https://bot.example.com/v1");
        assert_eq!(secret_data(&out.composed["connection-protected"])["OPENAI_BASE_URL"], "http://bot-gateway.ai.svc/v1");

        // Unset, neither gets one.
        let out = compose(&input(xr("{}", "{}"), &[], required(false, &[REQUIRED_CACHE_SECRET]))).unwrap();
        assert!(out.composed["database"].object["spec"].get("expose").is_none());
        assert!(out.composed["gateway"].object["spec"].get("expose").is_none());
    }

    #[test]
    fn audit_log_and_gateway_settings_go_to_the_children() {
        let req = || required(false, &[REQUIRED_CACHE_SECRET]);
        let out = compose(&input(xr(r#"{"retrieval":{"auditLog":" write, ddl, role "}}"#, "{}"), &[], req())).unwrap();
        assert_eq!(out.composed["database"].object["spec"]["postgresql"]["parameters"]["pgaudit.log"], "write, ddl, role");
        let gw = compose(&input(xr(r#"{"gateway":{"retry":{"attempts":3},"alerts":{"latencySeconds":20}}}"#, "{}"), &[], req())).unwrap();
        assert_eq!(gw.composed["gateway"].object["spec"]["retry"]["attempts"], 3);
        assert_eq!(gw.composed["gateway"].object["spec"]["alerts"]["latencySeconds"], 20);
        let gw = compose(&input(xr(r#"{"gateway":{"monthlyTokens":1000}}"#, "{}"), &[], req())).unwrap();
        assert_eq!(gw.composed["gateway"].object["spec"]["monthlyTokens"], 1000);
        let out = compose(&input(xr("{}", "{}"), &[], req())).unwrap();
        assert!(out.composed["database"].object["spec"].get("postgresql").is_none(), "postgresql without auditLog");
    }

    #[test]
    fn without_cache_and_gateway_only_the_database_and_wiring() {
        let out = compose(&input(xr(r#"{"cache":{"enabled":false},"gateway":{"enabled":false}}"#, "{}"), &[], required(false, &[]))).unwrap();
        for key in out.composed.keys() {
            assert!(!key.contains("cache") && !key.contains("gateway"), "{key} composed");
        }
        let conn = secret_data(&out.composed["connection-protected"]);
        assert!(!conn.contains_key("OPENAI_BASE_URL") && !conn.contains_key("VALKEY_URL"));
    }

    #[test]
    fn query_escapes_like_go() {
        assert_eq!(query_escape("a b+c/d?=&é"), "a+b%2Bc%2Fd%3F%3D%26%C3%A9");
    }
}
