//! Composes an MCPServer (ai.cndev.nl/v1alpha1): an MCP server with retrieval
//! and agent memory over a Project's database (basis-mcp, ../../../mcp), in
//! its protected site and optionally a standby in its recovery site.
//!
//! On the control plane, next to the XR:
//!
//!     keys             Secret <name>-keys: an API key per spec.clients entry,
//!                      generated once, then kept; a removed or expired
//!                      client's key goes
//!     dashboard        a GrafanaDashboard in the Project's Grafana
//!
//! In each site's location (provider-kubernetes Objects, prefix "<site>-"):
//!
//!     keys             Secret <name>-keys, data from the control plane's;
//!                      mounted, re-read by the server without a restart
//!     config           ConfigMap <name>-config: config.json, what the server
//!                      serves (tables, search mode, memory scope, the
//!                      clients and their tools)
//!     deployment       Deployment <name>: basis-mcp, the site's replicas, the
//!                      database and embeddings endpoint from the environment
//!                      (below); restarted when its config changes
//!     service          Service <name>:80, the endpoint http://<name>.<ns>.svc/mcp
//!     pdb              with more than one replica: PodDisruptionBudget, one stays
//!     podmonitor       the server's metrics (calls per tool and client,
//!                      latency, embeddings, database readiness)
//!     prometheusrule   with replicas in the site: down, database not ready,
//!                      failing tool calls, slow calls (spec.alerts), failing
//!                      embeddings
//!
//! The database: with spec.database.stack the stack's Secret
//! <stack>-connection in the location (DATABASE_URL, and OPENAI_BASE_URL and
//! OPENAI_API_KEY of the stack's gateway for the embeddings). With
//! spec.database.cluster its -rw Service, as the role of
//! spec.database.credentialsSecretRef (copied there, "database") or the
//! database owner (CloudNativePG's <cluster>-app); embeddings through
//! spec.embeddings.gateway with the server's own key there ("embeddings",
//! copied from the gateway's keys Secret).
//!
//! The active site, where the database's primary runs (the stack's
//! status.activeSite, the cluster's status.primarySite), gets spec.replicas,
//! the standby spec.recovery.replicas: it answers search, fetch and recall
//! from the replica, and refuses writes until the primary moves there.
//! Locations are pinned in status.sites, so a server never moves.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::common::gojson::{fmt_g, marshal, marshal_indent, quote};
use crate::common::lenient::decode;
use crate::common::util::{
    as_str, b64, condition_true, dig_opt, labels_obj, live, new_secret, or, or_f, or_i, past_day, reported, sha1hex, unb64,
};
use crate::common::{Composed, Condition, Input, Output, Requirement, Result};
use crate::lenient;

/// basis-mcp's image, built from ../../../mcp (mcp/Makefile's VERSION).
pub const DEFAULT_IMAGE: &str = "ghcr.io/bartvanbenthem/basis-mcp:v0.1.0";

// Requirement names.
pub const REQUIRED_PROJECT: &str = "project";
pub const REQUIRED_DATABASE: &str = "database";
pub const REQUIRED_GATEWAY_KEYS: &str = "gateway-keys";

// Ports of basis-mcp.
pub const HTTP_PORT: i64 = 8080;
pub const METRICS_PORT: i64 = 9090;

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
    /// The MCPServer XR, as far as the composition reads it. Fields mirror
    /// apis/mcpserver/definition.yaml; the accessors repeat the XRD defaults
    /// so `crossplane render` and older objects come out the same.
    pub struct Xr { pub metadata: Metadata, pub spec: Spec, pub status: XrStatus }
}
lenient! {
    pub struct SecretRef { pub name: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Database { pub stack: String, pub cluster: String, pub name: String, pub credentials_secret_ref: Option<SecretRef> }
}
lenient! {
    pub struct Embeddings { pub model: String, pub dimensions: i64, pub gateway: String, pub client: String }
}
lenient! {
    pub struct Columns {
        pub id: String,
        pub content: String,
        pub title: String,
        pub source: String,
        pub metadata: String,
        pub embedding: String,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Retrieval {
        pub enabled: Option<bool>,
        pub table: String,
        pub columns: Columns,
        pub mode: String,
        pub top_k: i64,
        pub text_search_config: String,
        pub ingest: bool,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Memory { pub enabled: Option<bool>, pub scope: String, pub retention_days: i64 }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Client { pub name: String, pub owner: String, pub tools: Vec<String>, pub expires_at: String }
}
lenient! {
    pub struct Resources { pub cpu: String, pub memory: String }
}
lenient! {
    pub struct Recovery { pub enabled: bool, pub replicas: Option<i64> }
}
lenient! {
    /// The thresholds of the server's alerts.
    #[serde(rename_all = "camelCase")]
    pub struct Alerts { pub error_rate_percent: f64, pub latency_seconds: f64, pub disabled: bool }
}
lenient! {
    pub struct Spec {
        pub database: Database,
        pub embeddings: Embeddings,
        pub retrieval: Retrieval,
        pub memory: Memory,
        pub clients: Option<Vec<Client>>,
        pub replicas: i64,
        pub resources: Resources,
        pub recovery: Recovery,
        pub image: String,
        pub alerts: Alerts,
    }
}

impl Spec {
    fn replicas(&self) -> i64 {
        or_i(self.replicas, 2)
    }
    fn standby_replicas(&self) -> i64 {
        self.recovery.replicas.unwrap_or(1)
    }
    fn retrieval(&self) -> bool {
        self.retrieval.enabled.unwrap_or(true)
    }
    fn memory(&self) -> bool {
        self.memory.enabled.unwrap_or(true)
    }
    fn embeds(&self) -> bool {
        !self.embeddings.model.is_empty()
    }
    fn cpu(&self) -> &str {
        or(&self.resources.cpu, "250m")
    }
    fn memory_limit(&self) -> &str {
        or(&self.resources.memory, "256Mi")
    }
    fn database_name(&self) -> &str {
        or(&self.database.name, "app")
    }
    /// The search mode: hybrid with a model, text without.
    fn mode(&self) -> &str {
        if !self.retrieval.mode.is_empty() {
            &self.retrieval.mode
        } else if self.embeds() {
            "hybrid"
        } else {
            "text"
        }
    }
    /// The server's client at embeddings.gateway.
    fn embeddings_client<'a>(&'a self, name: &'a str) -> &'a str {
        or(&self.embeddings.client, name)
    }
    /// spec.clients, the XRD's default when unset.
    fn client_list(&self) -> Vec<Client> {
        self.clients.clone().unwrap_or_else(|| vec![Client { name: "agents".into(), ..Default::default() }])
    }
}

impl Client {
    /// The client's key is past its last day (expiresAt, UTC).
    fn expired(&self) -> bool {
        past_day(&self.expires_at)
    }
}

impl Alerts {
    fn error_rate(&self) -> f64 {
        or_f(self.error_rate_percent, 5.0)
    }
    fn latency(&self) -> f64 {
        or_f(self.latency_seconds, 2.0)
    }
}

/// The Project (its sites), the database's XR (its active site), and with a
/// cluster's embeddings the gateway's keys.
pub fn requirements(input: &Input) -> BTreeMap<String, Requirement> {
    let x: Xr = decode(&input.xr);
    let ns = x.metadata.namespace.as_str();
    let mut reqs = BTreeMap::from([(REQUIRED_PROJECT.to_string(), Requirement::named("platform.cndev.nl/v1alpha1", "Project", "", ns))]);
    let db = &x.spec.database;
    if !db.stack.is_empty() {
        reqs.insert(REQUIRED_DATABASE.into(), Requirement::named("ai.cndev.nl/v1alpha1", "GenAIStack", ns, &db.stack));
    } else if !db.cluster.is_empty() {
        reqs.insert(REQUIRED_DATABASE.into(), Requirement::named("postgres.cndev.nl/v1alpha1", "PostgresCluster", ns, &db.cluster));
        if x.spec.embeds() && !x.spec.embeddings.gateway.is_empty() {
            reqs.insert(REQUIRED_GATEWAY_KEYS.into(),
                Requirement::named("v1", "Secret", ns, &format!("{}-keys", x.spec.embeddings.gateway)));
        }
    }
    reqs
}

/// The MCP endpoint of server name in namespace, the same in every site's location.
pub fn endpoint(name: &str, namespace: &str) -> String {
    format!("http://{name}.{namespace}.svc/mcp")
}

/// The Secret with the clients' API keys.
pub fn keys_secret(name: &str) -> String {
    format!("{name}-keys")
}

struct Composition<'a> {
    spec: &'a Spec,
    name: &'a str,
    ns: &'a str,
    labels: Map<String, Value>,
}

/// A manifest for a location, with how to tell it's ready.
struct Obj {
    manifest: Value,
    /// A Secret whose data comes from the control plane: from, and (field,
    /// to field) or None to copy data and type.
    copy_from: Option<(String, Option<(String, String)>)>,
    ready: crate::common::ReadyFn,
}

fn always(_: Option<&Value>) -> bool {
    true
}
fn object_ready(o: Option<&Value>) -> bool {
    condition_true(o, "Ready")
}

/// Renders the desired state of an MCPServer.
pub fn compose(input: &Input) -> Result<Output> {
    let xr: Xr = decode(&input.xr);
    let labels = labels_obj(&[
        ("app.kubernetes.io/managed-by", "crossplane"),
        ("app.kubernetes.io/part-of", "basis"),
        ("ai.cndev.nl/mcpserver", &xr.metadata.name),
    ]);
    let c = Composition { spec: &xr.spec, name: &xr.metadata.name, ns: &xr.metadata.namespace, labels };
    let (spec, name, ns) = (c.spec, c.name, c.ns);
    let observed = &input.observed;
    let mut out = Output::default();
    let mut problems: Vec<String> = vec![];

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

    // ---- the database, and where its primary is
    let db = input.first(REQUIRED_DATABASE);
    let (kind, db_name) = if spec.database.cluster.is_empty() {
        ("GenAIStack", spec.database.stack.as_str())
    } else {
        ("PostgresCluster", spec.database.cluster.as_str())
    };
    let mut active = SITE_PROTECTED;
    match db {
        None => problems.push(format!("no {kind} {db_name} in namespace {ns} (spec.database)")),
        Some(db) if kind == "GenAIStack" => {
            if as_str(db.pointer("/status/activeSite")) == SITE_RECOVERY && spec.recovery.enabled {
                active = SITE_RECOVERY;
            }
            if spec.recovery.enabled && db.pointer("/spec/recovery/enabled") != Some(&json!(true)) {
                problems.push(format!("GenAIStack {db_name} has no recovery site; set its spec.recovery.enabled"));
            }
            if spec.embeds() && db.pointer("/spec/gateway/enabled") == Some(&json!(false)) {
                problems.push(format!("GenAIStack {db_name} has no gateway for the embeddings (spec.gateway.enabled)"));
            }
        }
        Some(db) => {
            if as_str(db.pointer("/status/primarySite")) == SITE_RECOVERY && spec.recovery.enabled {
                active = SITE_RECOVERY;
            }
            if spec.recovery.enabled && db.pointer("/spec/geoReplication/enabled") != Some(&json!(true)) {
                problems.push(format!("PostgresCluster {db_name} isn't geo-replicated; set its spec.geoReplication.enabled"));
            }
        }
    }
    if !spec.database.cluster.is_empty() && spec.embeds() {
        let client = spec.embeddings_client(name);
        if unb64(as_str(dig_opt(input.first(REQUIRED_GATEWAY_KEYS), &["data", client]))).unwrap_or_default().is_empty() {
            problems.push(format!(
                "ModelGateway {} has no client {client} for the embeddings; add it to its spec.clients",
                spec.embeddings.gateway
            ));
        }
    }

    // ---- control plane: a key per client, the dashboard
    let tools = c.tools();
    let mut keys = Map::new();
    let mut expired = vec![];
    for cl in spec.client_list() {
        if cl.expired() {
            expired.push(cl.name);
            continue;
        }
        let key = dig_opt(observed.get("keys"), &["data", &cl.name])
            .and_then(Value::as_str)
            .and_then(unb64)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| new_secret(40));
        keys.insert(cl.name, json!(b64(&key)));
    }
    let n_clients = keys.len();
    let keys_ready = observed.contains_key("keys");
    out.composed.insert("keys".into(), Composed { ready: keys_ready, object: json!({
        "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
        "metadata": c.meta(&keys_secret(name)), "data": keys,
    })});
    let dashboard = c.dashboard();
    let dashboard_uid = dashboard["spec"]["uid"].clone();
    out.composed.insert("dashboard".into(), Composed { ready: true, object: dashboard });

    // ---- each site: the server in its location
    let mut all_ready = keys_ready;
    let mut waiting = vec![];
    let mut site_status = vec![];
    for s in &sites {
        let replicas = if *s == active { spec.replicas() } else { spec.standby_replicas() };
        let loc = location(s);
        if loc.is_empty() {
            site_status.push(json!({"site": s, "location": loc, "active": *s == active, "replicas": replicas, "ready": false}));
            problems.push(format!("Project {ns} has no {s} location (spec.locations.{s})"));
            all_ready = false;
            continue;
        }
        let mut ready = true;
        for (key, o) in c.site_objects(s, replicas) {
            let k = format!("{s}-{key}");
            let mut w = c.wrap(&k, &loc, o.manifest, o.copy_from.as_ref());
            w.ready = (o.ready)(observed.get(&k));
            ready = ready && w.ready;
            out.composed.insert(k, w);
        }
        if !ready {
            waiting.push(format!("{s} ({loc})"));
        }
        all_ready = all_ready && ready;
        site_status.push(json!({"site": s, "location": loc, "active": *s == active, "replicas": replicas, "ready": ready}));
    }
    all_ready = all_ready && problems.is_empty();

    let mut status = json!({"ready": all_ready, "message": "", "activeSite": active, "endpoint": endpoint(name, ns),
        "keysSecret": keys_secret(name), "clients": n_clients, "tools": tools, "toolCount": tools.len(),
        "database": format!("{kind}/{db_name}"), "dashboardUid": dashboard_uid, "sites": site_status});
    if !expired.is_empty() {
        status["expiredClients"] = json!(expired);
    }
    let mut cond = Condition { status: all_ready, reason: "Available".into(), message: String::new() };
    let msg = if !problems.is_empty() {
        cond.reason = "Waiting".into();
        problems.join("; ")
    } else if !all_ready && !waiting.is_empty() {
        // The pods are ready once the server has its database and tables:
        // what it waits for is in its log (and basis_mcp_database_ready).
        cond.reason = "Creating".into();
        format!("Waiting for the server's pods to be ready (database and tables) in {}", waiting.join(", "))
    } else if !all_ready {
        cond.reason = "Creating".into();
        "Waiting for the clients' keys".into()
    } else {
        format!("MCP server {name} is ready with {} tool(s) over {kind}/{db_name}; active site {active}", tools.len())
    };
    status["message"] = json!(msg);
    cond.message = msg;
    out.status = status;
    out.condition = cond;
    Ok(out)
}

impl Composition<'_> {
    /// The tools the server serves.
    fn tools(&self) -> Vec<&'static str> {
        let mut out = vec![];
        if self.spec.retrieval() {
            out.extend(["search", "fetch"]);
            if self.spec.retrieval.ingest {
                out.extend(["add_document", "delete_document"]);
            }
        }
        if self.spec.memory() {
            out.extend(["remember", "recall", "forget"]);
        }
        out
    }

    /// basis-mcp's config.json for a site.
    fn config(&self, site: &str) -> Value {
        let spec = self.spec;
        let r = &spec.retrieval;
        let mut retrieval = json!({"enabled": spec.retrieval(), "mode": spec.mode(), "topK": or_i(r.top_k, 8),
            "textSearchConfig": or(&r.text_search_config, "simple"), "ingest": r.ingest});
        if !r.table.is_empty() {
            let mut cols = json!({"id": or(&r.columns.id, "id"), "content": or(&r.columns.content, "content")});
            for (k, v) in [("title", &r.columns.title), ("source", &r.columns.source),
                ("metadata", &r.columns.metadata), ("embedding", &r.columns.embedding)] {
                if !v.is_empty() {
                    cols[k] = json!(v);
                }
            }
            retrieval["table"] = json!(r.table);
            retrieval["own"] = json!(false);
            retrieval["columns"] = cols;
        } else {
            retrieval["table"] = json!("mcp.documents");
            retrieval["own"] = json!(true);
        }
        let mut memory = json!({"enabled": spec.memory(), "table": "mcp.memories", "scope": or(&spec.memory.scope, "client")});
        if spec.memory.retention_days > 0 {
            memory["retentionDays"] = json!(spec.memory.retention_days);
        }
        let mut embeddings = json!({});
        if spec.embeds() {
            embeddings["model"] = json!(spec.embeddings.model);
            if spec.embeddings.dimensions > 0 {
                embeddings["dimensions"] = json!(spec.embeddings.dimensions);
            }
        }
        let clients: Map<String, Value> = spec
            .client_list()
            .into_iter()
            .filter(|cl| !cl.expired())
            .map(|cl| (cl.name, json!({"tools": cl.tools})))
            .collect();
        json!({"server": self.name, "namespace": self.ns, "site": site,
            "retrieval": retrieval, "memory": memory, "embeddings": embeddings, "clients": clients})
    }

    /// Secrets in the location for a cluster's database: the role's
    /// credentials, the server's key at the embeddings gateway.
    fn database_secret(&self) -> String {
        format!("{}-database", self.name)
    }
    fn embeddings_secret(&self) -> String {
        format!("{}-embeddings", self.name)
    }

    /// What runs in a site's location, by composition resource name (without
    /// the site prefix).
    fn site_objects(&self, site: &str, replicas: i64) -> BTreeMap<&'static str, Obj> {
        let (spec, name, ns) = (self.spec, self.name, self.ns);
        let mut out: BTreeMap<&'static str, Obj> = BTreeMap::new();
        out.insert("keys", Obj { ready: Box::new(object_ready), copy_from: Some((keys_secret(name), None)),
            manifest: json!({"apiVersion": "v1", "kind": "Secret", "metadata": self.meta(&keys_secret(name))})});
        let cfg = marshal_indent(&self.config(site), "  ");
        out.insert("config", Obj { ready: Box::new(reported), copy_from: None, manifest: json!({
            "apiVersion": "v1", "kind": "ConfigMap", "metadata": self.meta(&format!("{name}-config")),
            "data": {"config.json": cfg},
        })});

        // The database and the embeddings endpoint, from the environment.
        let mut env = vec![];
        let mut env_from = vec![];
        let secret_env = |n: &str, secret: &str, key: &str| json!({"name": n, "valueFrom": {"secretKeyRef": {"name": secret, "key": key}}});
        if !spec.database.stack.is_empty() {
            // DATABASE_URL, OPENAI_BASE_URL and OPENAI_API_KEY (and the cache's, unused).
            env_from.push(json!({"secretRef": {"name": format!("{}-connection", spec.database.stack)}}));
        } else {
            let cluster = &spec.database.cluster;
            let mut credentials = format!("{cluster}-app");
            if let Some(r) = &spec.database.credentials_secret_ref {
                credentials = self.database_secret();
                out.insert("database", Obj { ready: Box::new(object_ready), copy_from: Some((r.name.clone(), None)),
                    manifest: json!({"apiVersion": "v1", "kind": "Secret", "metadata": self.meta(&self.database_secret())})});
            }
            // libpq's variables: they fill in what the URL leaves out.
            env.push(json!({"name": "DATABASE_URL", "value": format!("postgresql://{cluster}-rw.{ns}.svc:5432/{}", spec.database_name())}));
            env.push(secret_env("PGUSER", &credentials, "username"));
            env.push(secret_env("PGPASSWORD", &credentials, "password"));
            if spec.embeds() {
                let gw = &spec.embeddings.gateway;
                out.insert("embeddings", Obj { ready: Box::new(object_ready),
                    copy_from: Some((format!("{gw}-keys"), Some((format!("data.{}", spec.embeddings_client(name)), "data.apiKey".into())))),
                    manifest: json!({"apiVersion": "v1", "kind": "Secret", "type": "Opaque", "metadata": self.meta(&self.embeddings_secret())})});
                env.push(json!({"name": "OPENAI_BASE_URL", "value": format!("http://{gw}.{ns}.svc/v1")}));
                env.push(secret_env("OPENAI_API_KEY", &self.embeddings_secret(), "apiKey"));
            }
        }

        let selector = json!({"app.kubernetes.io/name": "basis-mcp", "ai.cndev.nl/mcpserver": name});
        let pod_labels = json!({"app.kubernetes.io/part-of": "basis", "app.kubernetes.io/name": "basis-mcp", "ai.cndev.nl/mcpserver": name});
        let image = or(&spec.image, DEFAULT_IMAGE);
        let probe = |path: &str, period: i64| json!({"httpGet": {"path": path, "port": "http"}, "periodSeconds": period, "timeoutSeconds": 3});
        let mut container = json!({
            "name": "server", "image": image,
            "args": ["--config=/etc/basis-mcp/config/config.json", "--keys=/etc/basis-mcp/keys"],
            "ports": [{"name": "http", "containerPort": HTTP_PORT}, {"name": "metrics", "containerPort": METRICS_PORT}],
            // Ready once it has its database and tables (and its model): a
            // gateway or agent only gets pods that can answer.
            "readinessProbe": probe("/readyz", 10),
            "livenessProbe": probe("/healthz", 20),
            "resources": {"requests": {"cpu": spec.cpu(), "memory": spec.memory_limit()}, "limits": {"memory": spec.memory_limit()}},
            "securityContext": {"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "capabilities": {"drop": ["ALL"]}},
            "volumeMounts": [
                {"name": "config", "mountPath": "/etc/basis-mcp/config", "readOnly": true},
                {"name": "keys", "mountPath": "/etc/basis-mcp/keys", "readOnly": true},
            ],
        });
        if !env.is_empty() {
            container["env"] = json!(env);
        }
        if !env_from.is_empty() {
            container["envFrom"] = json!(env_from);
        }
        let hash = sha1hex(&format!("{cfg}{image}"))[..16].to_string();
        out.insert("deployment", Obj {
            ready: Box::new(move |o| {
                if replicas == 0 {
                    return reported(o);
                }
                dig_opt(live(o), &["status", "readyReplicas"]).and_then(Value::as_f64).unwrap_or(0.0) >= 1.0
            }),
            copy_from: None,
            manifest: json!({
                "apiVersion": "apps/v1", "kind": "Deployment", "metadata": self.meta(name),
                "spec": {
                    "replicas": replicas,
                    "selector": {"matchLabels": selector},
                    "template": {
                        // A new config is a rollout; new keys are read in place.
                        "metadata": {"labels": pod_labels, "annotations": {"ai.cndev.nl/config-hash": hash}},
                        "spec": {
                            "automountServiceAccountToken": false,
                            "securityContext": {"runAsNonRoot": true, "runAsUser": 65532, "runAsGroup": 65532, "fsGroup": 65532,
                                "seccompProfile": {"type": "RuntimeDefault"}},
                            "topologySpreadConstraints": [{"maxSkew": 1, "topologyKey": "kubernetes.io/hostname",
                                "whenUnsatisfiable": "ScheduleAnyway", "labelSelector": {"matchLabels": selector}}],
                            "containers": [container],
                            "volumes": [
                                {"name": "config", "configMap": {"name": format!("{name}-config")}},
                                {"name": "keys", "secret": {"secretName": keys_secret(name), "defaultMode": 0o440}},
                            ],
                        },
                    },
                },
            }),
        });
        out.insert("service", Obj { ready: Box::new(reported), copy_from: None, manifest: json!({
            "apiVersion": "v1", "kind": "Service", "metadata": self.meta(name),
            "spec": {"type": "ClusterIP", "selector": selector,
                "ports": [{"name": "http", "port": 80, "targetPort": "http", "appProtocol": "http"}]},
        })});
        if replicas > 1 {
            out.insert("pdb", Obj { ready: Box::new(always), copy_from: None, manifest: json!({
                "apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": self.meta(name),
                "spec": {"minAvailable": 1, "selector": {"matchLabels": selector}},
            })});
        }
        out.insert("podmonitor", Obj { ready: Box::new(always), copy_from: None, manifest: self.pod_monitor(&selector) });
        if !spec.alerts.disabled && replicas > 0 {
            out.insert("prometheusrule", Obj { ready: Box::new(always), copy_from: None, manifest: self.alert_rules() });
        }
        out
    }

    /// Puts a location object into a provider-kubernetes Object.
    fn wrap(&self, key: &str, location: &str, manifest: Value, copy_from: Option<&(String, Option<(String, String)>)>) -> Composed {
        let mut spec = json!({
            "providerConfigRef": {"kind": "ClusterProviderConfig", "name": location},
            "watch": true,
            "forProvider": {"manifest": manifest},
        });
        if let Some((from, field)) = copy_from {
            // The Secret's data comes from the control plane, never through this spec.
            spec["references"] = match field {
                None => json!(["data", "type"].iter().map(|f| json!({"patchesFrom": {"apiVersion": "v1", "kind": "Secret",
                    "name": from, "namespace": self.ns, "fieldPath": f}})).collect::<Vec<_>>()),
                Some((field, to)) => json!([{"patchesFrom": {"apiVersion": "v1", "kind": "Secret",
                    "name": from, "namespace": self.ns, "fieldPath": field}, "toFieldPath": to}]),
            };
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

    // ---- monitoring, from basis-mcp's own metrics (basis_mcp_*)

    /// Scrapes the server's pods, every series labelled with the server.
    /// Only basis_mcp_* is kept.
    fn pod_monitor(&self, selector: &Value) -> Value {
        json!({
            "apiVersion": "monitoring.coreos.com/v1", "kind": "PodMonitor", "metadata": self.meta(&format!("{}-mcp", self.name)),
            "spec": {
                "selector": {"matchLabels": selector},
                "podMetricsEndpoints": [{
                    "port": "metrics", "path": "/metrics", "interval": "30s",
                    "relabelings": [{"targetLabel": "server", "replacement": self.name}],
                    "metricRelabelings": [{"sourceLabels": ["__name__"], "regex": "basis_mcp_.*", "action": "keep"}],
                }],
            },
        })
    }

    /// The server's alerts in a site with replicas: none of them up, the
    /// database not usable, tool calls failing or slow, and with embeddings
    /// the model failing.
    fn alert_rules(&self) -> Value {
        let a = &self.spec.alerts;
        let name = self.name;
        let sel = format!("namespace={},server={}", quote(self.ns), quote(name));
        let labels = json!({"severity": "warning", "mcpserver": name});
        let mut rules = vec![
            json!({"alert": "BasisMCPServerDown", "for": "10m", "labels": labels,
                "expr": format!("(sum(up{{{sel}}}) or vector(0)) < 1"),
                "annotations": {"summary": format!("MCP server {name}: no replica serves in this site")}}),
            json!({"alert": "BasisMCPServerDatabaseNotReady", "for": "10m", "labels": labels,
                "expr": format!("max(basis_mcp_database_ready{{{sel}}}) < 1"),
                "annotations": {"summary": format!("MCP server {name} can't use its database (the server's log says why: \
                    unreachable, no vector extension, missing table or column, the embeddings model)")}}),
            json!({"alert": "BasisMCPServerErrors", "for": "10m", "labels": labels,
                "expr": format!("100 * sum(rate(basis_mcp_tool_calls_total{{{sel},outcome=\"error\"}}[10m])) / sum(rate(basis_mcp_tool_calls_total{{{sel}}}[10m])) > {}",
                    fmt_g(a.error_rate())),
                "annotations": {"summary": format!("MCP server {name}: {{{{ $value | printf \"%.1f\" }}}}% of tool calls fail (threshold {}%)",
                    fmt_g(a.error_rate()))}}),
            json!({"alert": "BasisMCPServerSlow", "for": "15m", "labels": labels,
                "expr": format!("histogram_quantile(0.95, sum by (le) (rate(basis_mcp_tool_duration_seconds_bucket{{{sel}}}[10m]))) > {}", fmt_g(a.latency())),
                "annotations": {"summary": format!("MCP server {name}: 95% of tool calls take up to {{{{ $value | humanizeDuration }}}} (threshold {}s)",
                    fmt_g(a.latency()))}}),
        ];
        if self.spec.embeds() {
            rules.push(json!({"alert": "BasisMCPServerEmbeddingsFailing", "for": "10m", "labels": labels,
                "expr": format!("sum(rate(basis_mcp_embedding_requests_total{{{sel},outcome=\"error\"}}[10m])) / sum(rate(basis_mcp_embedding_requests_total{{{sel}}}[10m])) > 0.5"),
                "annotations": {"summary": format!("MCP server {name}: most calls to embeddings model {} fail; search falls back to full text, new rows wait for their embedding",
                    self.spec.embeddings.model)}}));
        }
        json!({"apiVersion": "monitoring.coreos.com/v1", "kind": "PrometheusRule", "metadata": self.meta(&format!("{name}-mcp-alerts")),
            "spec": {"groups": [{"name": format!("mcpserver/{}/{name}", self.ns), "rules": rules}]}})
    }

    /// The server's dashboard in the Project's Grafana (control plane): calls,
    /// failures and latency per tool, calls per client, hits, the embeddings
    /// model, the database.
    fn dashboard(&self) -> Value {
        let uid = format!("basis-mcp-{}", &sha1hex(&format!("{}/{}", self.ns, self.name))[..12]);
        json!({
            "apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDashboard", "metadata": self.meta(&format!("{}-mcp", self.name)),
            "spec": {
                "instanceSelector": {"matchLabels": {"dashboards.paas.cndev.nl/scope": self.ns}},
                "folder": "MCP servers",
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
        let p = |quantile: &str, metric: &str, by: &str| {
            format!("histogram_quantile({quantile}, sum by (le, {by}) (rate({metric}_bucket{{{sel}}}[$__rate_interval])))")
        };
        let calls = |by: &str, extra: &str| format!("sum by ({by}) (rate(basis_mcp_tool_calls_total{{{sel}{extra}}}[$__rate_interval]))");
        let panels = vec![
            panel("Tool calls per second", "reqps", 0, 0, vec![q(calls("tool", ""), "{{tool}}")]),
            panel("Failed tool calls per second", "reqps", 12, 0, vec![q(calls("tool", ",outcome=\"error\""), "{{tool}}")]),
            panel("Tool call duration (p50, p95)", "s", 0, 8, vec![
                q(p("0.5", "basis_mcp_tool_duration_seconds", "tool"), "p50 {{tool}}"),
                q(p("0.95", "basis_mcp_tool_duration_seconds", "tool"), "p95 {{tool}}"),
            ]),
            panel("Calls per client", "reqps", 12, 8, vec![q(calls("client", ""), "{{client}}")]),
            // Few hits for a search: the knowledge base lacks what agents look for.
            panel("Hits per search and recall (p50)", "short", 0, 16, vec![q(p("0.5", "basis_mcp_tool_results", "tool"), "{{tool}}")]),
            panel("Embeddings model: calls and p95 latency", "short", 12, 16, vec![
                q(format!("sum by (outcome) (rate(basis_mcp_embedding_requests_total{{{sel}}}[$__rate_interval]))"), "{{outcome}} /s"),
                q(format!("histogram_quantile(0.95, sum by (le) (rate(basis_mcp_embedding_duration_seconds_bucket{{{sel}}}[$__rate_interval])))"), "p95 s"),
            ]),
            panel("Database ready", "short", 0, 24, vec![q(format!("min by (site) (basis_mcp_database_ready{{{sel}}})"), "{{site}}")]),
            panel("Backfilled embeddings and expired memories", "short", 12, 24, vec![
                q(format!("sum(increase(basis_mcp_backfilled_embeddings_total{{{sel}}}[$__rate_interval]))"), "backfilled"),
                q(format!("sum(increase(basis_mcp_expired_memories_total{{{sel}}}[$__rate_interval]))"), "expired"),
            ]),
        ];
        let d = json!({
            "uid": uid, "title": format!("MCP server: {}", self.name), "schemaVersion": 39, "refresh": "1m",
            "time": {"from": "now-6h", "to": "now"}, "tags": ["basis", "mcpserver"],
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
    use crate::common::util::{set_now, set_secret};
    use chrono::TimeZone;

    fn xr(spec: &str, status: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"apiVersion":"ai.cndev.nl/v1alpha1","kind":"MCPServer","metadata":{{"name":"kb","namespace":"ai"}},"spec":{spec},"status":{status}}}"#
        ))
        .unwrap()
    }

    fn project(recovery: bool) -> Value {
        let mut locations = json!({"protected": "dc-a"});
        if recovery {
            locations["recovery"] = json!("dc-b");
        }
        json!({"spec": {"locations": locations}})
    }

    /// A GenAIStack as the composition sees it.
    fn stack(recovery: bool, active_site: &str) -> Value {
        json!({"spec": {"recovery": {"enabled": recovery}}, "status": {"activeSite": active_site}})
    }

    fn input(xr: Value, required: &[(&str, Value)]) -> Input {
        Input { xr, required: required.iter().map(|(k, v)| (k.to_string(), vec![v.clone()])).collect(), ..Default::default() }
    }

    fn manifest<'a>(out: &'a Output, key: &str) -> &'a Value {
        &out.composed[key].object["spec"]["forProvider"]["manifest"]
    }

    fn container<'a>(out: &'a Output, site: &str) -> &'a Value {
        let cs = manifest(out, &format!("{site}-deployment"))["spec"]["template"]["spec"]["containers"].as_array().unwrap();
        assert_eq!(cs.len(), 1, "{site}: containers");
        &cs[0]
    }

    fn config(out: &Output, site: &str) -> Value {
        serde_json::from_str(manifest(out, &format!("{site}-config"))["data"]["config.json"].as_str().unwrap()).unwrap()
    }

    fn location(out: &Output, key: &str) -> Value {
        out.composed[key].object["spec"]["providerConfigRef"]["name"].clone()
    }

    fn key(out: &Output, client: &str) -> String {
        unb64(out.composed["keys"].object["data"][client].as_str().unwrap_or_default()).unwrap_or_default()
    }

    fn message(out: &Output) -> &str {
        out.status["message"].as_str().unwrap()
    }

    #[test]
    fn compose_stack() {
        set_secret(Some("generated"));
        let req = [(REQUIRED_PROJECT, project(true)), (REQUIRED_DATABASE, stack(false, "protected"))];
        let out = compose(&input(xr(r#"{"database":{"stack":"support"}}"#, "{}"), &req)).unwrap();
        assert!(!out.composed.contains_key("recovery-deployment"), "recovery site without recovery.enabled");
        for k in ["keys", "dashboard", "protected-keys", "protected-config", "protected-deployment", "protected-service",
            "protected-pdb", "protected-podmonitor", "protected-prometheusrule"] {
            assert!(out.composed.contains_key(k), "no {k}");
        }
        for k in ["protected-database", "protected-embeddings"] {
            assert!(!out.composed.contains_key(k), "{k} with a stack: it brings its own");
        }
        assert_eq!(location(&out, "protected-deployment"), "dc-a");
        let main = container(&out, "protected");
        assert_eq!(main["image"], DEFAULT_IMAGE);
        assert_eq!(main["envFrom"][0]["secretRef"]["name"], "support-connection", "the stack's connection Secret");
        assert!(main.get("env").is_none());
        assert_eq!(manifest(&out, "protected-deployment")["spec"]["replicas"], 2, "replicas: 2 by default");
        // The XRD's defaults: text search without a model, the server's own tables, client agents.
        let cfg = config(&out, "protected");
        assert_eq!(cfg["retrieval"]["mode"], "text");
        assert_eq!(cfg["retrieval"]["table"], "mcp.documents");
        assert_eq!(cfg["retrieval"]["own"], true);
        assert_eq!(cfg["memory"]["scope"], "client");
        assert_eq!(cfg["site"], "protected");
        assert!(cfg["clients"].get("agents").is_some());
        assert_eq!(cfg["embeddings"], json!({}));
        assert_eq!(key(&out, "agents"), "generated");
        assert_eq!(out.composed["keys"].object["data"].as_object().unwrap().len(), 1);
        let refs = out.composed["protected-keys"].object["spec"]["references"].as_array().unwrap();
        assert!(refs.len() == 2 && refs[0]["patchesFrom"]["name"] == "kb-keys", "keys copied from the control plane: {refs:?}");
        assert!(manifest(&out, "protected-keys").get("data").is_none(), "key data in the Object spec");
        let s = &out.status;
        assert_eq!(s["endpoint"], "http://kb.ai.svc/mcp");
        assert_eq!(s["database"], "GenAIStack/support");
        assert_eq!(s["activeSite"], "protected");
        assert_eq!(s["clients"], 1);
        assert_eq!(s["tools"], json!(["search", "fetch", "remember", "recall", "forget"]));
        assert_eq!(s["toolCount"], 5);
        assert_eq!(s["ready"], false);
        assert_eq!(s["keysSecret"], "kb-keys");
        assert_eq!(out.condition.reason, "Creating");
        assert!(message(&out).contains("Waiting for the server's pods"), "{}", message(&out));

        // Ready once the location reports ready pods and the keys exist.
        let mut observed = BTreeMap::from([("keys".to_string(), json!({"data": {"agents": b64("kept")}}))]);
        for (k, c) in &out.composed {
            if k.starts_with("protected-") {
                observed.insert(k.clone(), json!({"status": {"conditions": [{"type": "Ready", "status": "True"}],
                    "atProvider": {"manifest": c.object["spec"]["forProvider"]["manifest"]}}}));
            }
        }
        observed.insert("protected-deployment".into(),
            json!({"status": {"atProvider": {"manifest": {"kind": "Deployment", "status": {"readyReplicas": 1}}}}}));
        let out = compose(&Input { observed, ..input(xr(r#"{"database":{"stack":"support"}}"#, "{}"), &req) }).unwrap();
        assert_eq!(out.status["ready"], true);
        assert_eq!(out.condition.reason, "Available");
        assert!(message(&out).contains("ready with 5 tool(s) over GenAIStack/support"), "{}", message(&out));
        assert_eq!(key(&out, "agents"), "kept", "an existing key must be kept");
        set_secret(None);
    }

    #[test]
    fn compose_cluster() {
        set_secret(Some("generated"));
        let spec = r#"{"database":{"cluster":"docs","name":"kb","credentialsSecretRef":{"name":"kb-role"}},
            "embeddings":{"model":"bge-m3","gateway":"shared","dimensions":512},
            "retrieval":{"table":"public.chunks","columns":{"content":"body","embedding":"vec"},"topK":4,"textSearchConfig":"english"},
            "memory":{"scope":"shared","retentionDays":90},
            "clients":[{"name":"claude"},{"name":"reader","tools":["search","fetch"]}],
            "replicas":1,"image":"registry.local/basis-mcp:v1"}"#;
        let req = |keys: Value| {
            input(xr(spec, "{}"), &[(REQUIRED_PROJECT, project(false)), (REQUIRED_DATABASE, json!({"status": {"primarySite": "protected"}})),
                (REQUIRED_GATEWAY_KEYS, keys)])
        };
        let reqs = requirements(&input(xr(spec, "{}"), &[]));
        assert_eq!(reqs[REQUIRED_DATABASE].kind, "PostgresCluster");
        assert_eq!(reqs[REQUIRED_DATABASE].name.as_deref(), Some("docs"));
        assert_eq!(reqs[REQUIRED_GATEWAY_KEYS].name.as_deref(), Some("shared-keys"));

        let out = compose(&req(json!({"data": {"kb": b64("gw-key")}}))).unwrap();
        let main = container(&out, "protected");
        let env: BTreeMap<String, String> = main["env"].as_array().unwrap().iter().map(|e| {
            let v = match e.get("value") {
                Some(v) => v.as_str().unwrap().to_string(),
                None => {
                    let r = &e["valueFrom"]["secretKeyRef"];
                    format!("{}/{}", r["name"].as_str().unwrap(), r["key"].as_str().unwrap())
                }
            };
            (e["name"].as_str().unwrap().to_string(), v)
        }).collect();
        for (k, v) in [("DATABASE_URL", "postgresql://docs-rw.ai.svc:5432/kb"), ("PGUSER", "kb-database/username"),
            ("PGPASSWORD", "kb-database/password"), ("OPENAI_BASE_URL", "http://shared.ai.svc/v1"), ("OPENAI_API_KEY", "kb-embeddings/apiKey")] {
            assert_eq!(env.get(k).map(String::as_str), Some(v), "env {k}");
        }
        assert_eq!(main["image"], "registry.local/basis-mcp:v1");
        let r = &out.composed["protected-embeddings"].object["spec"]["references"][0];
        assert_eq!(r["patchesFrom"]["name"], "shared-keys", "the server's key at the gateway");
        assert_eq!(r["patchesFrom"]["fieldPath"], "data.kb");
        assert_eq!(r["toFieldPath"], "data.apiKey");
        assert_eq!(out.composed["protected-database"].object["spec"]["references"][0]["patchesFrom"]["name"], "kb-role",
            "the role's credentials copied");
        assert!(!out.composed.contains_key("protected-pdb"), "a PodDisruptionBudget for one replica blocks node drains");

        let cfg = config(&out, "protected");
        assert_eq!(cfg["retrieval"]["mode"], "hybrid");
        assert_eq!(cfg["retrieval"]["own"], false);
        assert_eq!(cfg["retrieval"]["columns"]["content"], "body");
        assert_eq!(cfg["retrieval"]["columns"]["id"], "id");
        assert_eq!(cfg["retrieval"]["topK"], 4);
        assert_eq!(cfg["embeddings"]["model"], "bge-m3");
        assert_eq!(cfg["embeddings"]["dimensions"], 512);
        assert_eq!(cfg["memory"]["scope"], "shared");
        assert_eq!(cfg["memory"]["retentionDays"], 90);
        assert_eq!(cfg["clients"]["reader"]["tools"], json!(["search", "fetch"]));
        assert_eq!(cfg["clients"]["claude"]["tools"], json!([]));
        let rules = manifest(&out, "protected-prometheusrule")["spec"]["groups"][0]["rules"].as_array().unwrap();
        assert!(rules.len() == 5 && rules[4]["alert"] == "BasisMCPServerEmbeddingsFailing", "with embeddings, five rules: {rules:?}");
        assert_eq!(out.status["database"], "PostgresCluster/docs");
        assert_eq!(out.condition.reason, "Creating");

        // The gateway hasn't got the server's client.
        let out = compose(&req(json!({"data": {}}))).unwrap();
        assert_eq!(out.condition.reason, "Waiting");
        assert!(message(&out).contains("ModelGateway shared has no client kb for the embeddings"), "{}", message(&out));
        set_secret(None);
    }

    #[test]
    fn compose_recovery() {
        let spec = r#"{"database":{"stack":"support"},"embeddings":{"model":"m"},"replicas":3,"recovery":{"enabled":true,"replicas":1}}"#;
        let out = compose(&input(xr(spec, "{}"), &[(REQUIRED_PROJECT, project(true)), (REQUIRED_DATABASE, stack(true, "recovery"))])).unwrap();
        assert_eq!(out.status["activeSite"], "recovery", "follows the stack's");
        assert_eq!(manifest(&out, "recovery-deployment")["spec"]["replicas"], 3, "the active site gets spec.replicas");
        assert_eq!(manifest(&out, "protected-deployment")["spec"]["replicas"], 1, "the standby recovery.replicas");
        assert_eq!(location(&out, "recovery-deployment"), "dc-b");
        assert_eq!(config(&out, "recovery")["site"], "recovery");
        let sites = out.status["sites"].as_array().unwrap();
        assert!(sites.len() == 2 && sites[1]["active"] == true && sites[0]["active"] == false, "sites {sites:?}");

        // Pinned sites stay; a stack without a recovery site is a problem.
        let out = compose(&input(xr(spec, r#"{"sites":[{"site":"protected","location":"dc-old"}]}"#),
            &[(REQUIRED_PROJECT, project(true)), (REQUIRED_DATABASE, stack(false, "protected"))])).unwrap();
        assert_eq!(location(&out, "protected-deployment"), "dc-old", "a pinned site moved");
        assert!(message(&out).contains("GenAIStack support has no recovery site"), "{}", message(&out));
        assert_eq!(out.status["ready"], false);

        // A standby with no replicas has no alerts.
        let out = compose(&input(xr(r#"{"database":{"stack":"support"},"recovery":{"enabled":true,"replicas":0}}"#, "{}"),
            &[(REQUIRED_PROJECT, project(true)), (REQUIRED_DATABASE, stack(true, "protected"))])).unwrap();
        assert!(!out.composed.contains_key("recovery-prometheusrule"), "alerts for a standby without replicas");
        assert!(out.composed.contains_key("protected-prometheusrule"), "no alerts for the active site");
    }

    #[test]
    fn compose_clients() {
        set_now(Some(chrono::Utc.with_ymd_and_hms(2026, 10, 23, 12, 0, 0).unwrap()));
        let spec = r#"{"database":{"stack":"support"},"retrieval":{"ingest":true},"memory":{"enabled":false},
            "clients":[{"name":"old","expiresAt":"2026-10-22"},{"name":"today","expiresAt":"2026-10-23"},{"name":"ci","tools":["search"]}]}"#;
        let run = |spec: &str| {
            compose(&input(xr(spec, "{}"), &[(REQUIRED_PROJECT, project(false)), (REQUIRED_DATABASE, stack(false, ""))])).unwrap()
        };
        let out = run(spec);
        let keys = &out.composed["keys"].object["data"];
        assert!(keys.get("old").is_none() && keys.get("today").is_some() && keys.get("ci").is_some(),
            "keys {keys}: an expired client's goes, the last day still counts");
        assert!(config(&out, "protected")["clients"].get("old").is_none(), "an expired client in the config");
        assert_eq!(out.status["expiredClients"], json!(["old"]));
        assert_eq!(out.status["clients"], 2);
        assert_eq!(out.status["tools"], json!(["search", "fetch", "add_document", "delete_document"]));

        // A config change rolls the pods (the hash); the keys don't.
        let hash = |o: &Output| manifest(o, "protected-deployment")["spec"]["template"]["metadata"]["annotations"]["ai.cndev.nl/config-hash"].clone();
        let other = run(&spec.replacen(r#""tools":["search"]"#, r#""tools":["search","fetch"]"#, 1));
        assert!(hash(&out).is_string());
        assert_ne!(hash(&out), hash(&other), "the config hash didn't change with the config");
        set_now(None);
    }

    #[test]
    fn compose_problems() {
        let out = compose(&input(xr(r#"{"database":{"stack":"nope"},"alerts":{"disabled":true}}"#, "{}"), &[(REQUIRED_PROJECT, json!({}))])).unwrap();
        assert!(message(&out).contains("no GenAIStack nope in namespace ai") && message(&out).contains("Project ai has no protected location"),
            "{}", message(&out));
        assert_eq!(out.condition.reason, "Waiting");
        let out = compose(&input(xr(r#"{"database":{"stack":"s"},"embeddings":{"model":"m"}}"#, "{}"),
            &[(REQUIRED_PROJECT, project(false)), (REQUIRED_DATABASE, json!({"spec": {"gateway": {"enabled": false}}}))])).unwrap();
        assert!(message(&out).contains("GenAIStack s has no gateway for the embeddings"), "{}", message(&out));
        let out = compose(&input(xr(r#"{"database":{"cluster":"c","credentialsSecretRef":{"name":"r"}},"recovery":{"enabled":true}}"#, "{}"),
            &[(REQUIRED_PROJECT, project(true)), (REQUIRED_DATABASE, json!({"spec": {}}))])).unwrap();
        assert!(message(&out).contains("PostgresCluster c isn't geo-replicated"), "{}", message(&out));
        assert!(out.composed.contains_key("protected-prometheusrule"), "alerts on by default");
    }
}
