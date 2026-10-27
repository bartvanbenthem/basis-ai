//! Composes a PostgresCluster (postgres.cndev.nl/v1alpha1).
//!
//! The namespaced XR lives in its Project's namespace on the control plane,
//! which runs no databases. The CNPG and Prometheus Operator objects go to the
//! Project's locations, each wrapped in a provider-kubernetes Object; only the
//! GrafanaDashboard is composed directly (the project's Grafana runs on the
//! control plane).
//!
//! Readiness: every composed resource reports its readiness explicitly
//! (non-managed resources have no generic Ready signal), so the XR's own Ready
//! condition means "Cluster healthy + every extra object exists".
//!
//! Sites: the Project (a required resource, named after the namespace) has a
//! protected location and optionally a recovery location (spec.locations).
//! The XR pins them in status.sites on first use, so a cluster never moves,
//! and a missing Project never empties the composition.
//!
//! Members: a member is what one location runs (Cluster, backups, databases,
//! poolers, monitors). The protected site is the member with resource-name
//! prefix "", the recovery site (spec.geoReplication) the member with prefix
//! "recovery-". Every object is wrapped in a provider-kubernetes Object for
//! the ClusterProviderConfig named after the location. See topology.rs for
//! how the primary moves between them.
//!
//! Backups without backup.destinationPath go to the Project's backup bucket
//! (COSI, Project status.backup): every member archives there with the
//! credentials the Project unpacked for its location (Secret
//! backup-s3-<location> in the project namespace), copied to the location as
//! <name>-backup-s3. The bucket is pinned in status.backupStore on first use.
//!
//! Restore (spec.restore, only at creation): the protected site's Cluster
//! bootstraps with recovery from another cluster's backup folder, through a
//! read-only ObjectStore <name>-restore (no retentionPolicy: nothing is ever
//! deleted through it). The restored cluster archives to a folder of its own,
//! <name>-<uid[:8]>, so it never writes into the source's folder, not even when
//! it takes the name of a deleted cluster. Its replica cluster's folder is
//! <that>-<recovery location>.
//!
//! Sizes (spec.size): the EnvironmentConfig "postgres-sizes" (data.sizes, a
//! list of {name, resources, parameters, ...}) says what each size gets: the
//! instances' resources and tuned postgresql.conf settings, under the ones
//! spec.postgresql.parameters sets. Without spec.size, spec.resources (or
//! 500m/1Gi) applies. The result is kept in status.sizing: while the catalog
//! can't be read or has dropped the size, the cluster keeps running with that,
//! never with the defaults. Changing a size in the catalog resizes every cluster
//! of that size (CNPG restarts the instances one by one, the primary last).
//!
//! Extensions (spec.database.extensions, spec.databases[].extensions): the
//! EnvironmentConfig "postgres-extensions" (data.extensions, a list of {name,
//! parameters, sharedPreloadLibraries, image, ...}) is what the admission
//! policy lets clusters add. The parameters of the extensions in use go under
//! the size's and spec's settings, their libraries are preloaded, and one with
//! an image (PostgreSQL 18+) is mounted from it (CNPG image volume
//! extensions); see extensions.rs. The bootstrap database gets a CNPG Database
//! of its own (databaseReclaimPolicy retain) for its extensions.
//!
//! Profiles (spec.profile): general, or vector for embeddings and hybrid
//! search. The size's settings for the profile (sizes[].profiles.<profile>)
//! go over the size's own and are kept in status.sizing with them; vector
//! clusters also export metrics on their vector indexes.

mod extensions;
mod member;
mod observed;
mod spec;
mod status;
mod topology;

#[cfg(test)]
mod tests;

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::common::gojson::fmt_g;
use crate::common::lenient::decode;
use crate::common::util::{as_str, dig, or, or_i, sha1hex, trunc};
use crate::common::{Composed, Input, Output, Requirement, Result};
use crate::lenient;
use extensions::ExtensionConfig;
use crate::common::kinds::Labels;
use observed::{ClusterStatus, live, read_cluster_status};
use spec::{Backup, BackupStore, S3Credentials, Sites, Sizing, Spec, Store, Xr};
use topology::{MemberPlacement, Placement, SWITCHOVER, TopologyMember, place};

pub use spec::{PROFILE_GENERAL, PROFILE_VECTOR};

// The resources the composition reads besides the XR, by requirement name.
pub const REQUIRED_PROJECT: &str = "project";
pub const REQUIRED_SIZES: &str = "sizes";
pub const REQUIRED_EXTENSIONS: &str = "extensions";

/// What compose reads besides the XR: the Project named after the XR's
/// namespace and the two catalogs.
pub fn requirements(input: &Input) -> BTreeMap<String, Requirement> {
    let ns = as_str(input.xr.pointer("/metadata/namespace"));
    BTreeMap::from([
        (REQUIRED_PROJECT.to_string(), Requirement::named("platform.cndev.nl/v1alpha1", "Project", "", ns)),
        (REQUIRED_SIZES.to_string(), Requirement::named("apiextensions.crossplane.io/v1beta1", "EnvironmentConfig", "", "postgres-sizes")),
        (REQUIRED_EXTENSIONS.to_string(),
            Requirement::named("apiextensions.crossplane.io/v1beta1", "EnvironmentConfig", "", "postgres-extensions")),
    ])
}

/// One reconcile in progress.
pub(crate) struct Composition<'a> {
    input: &'a Input,
    xr: Xr,
    spec: Spec,
    name: String,
    ns: String,
    /// Raw, as observed.
    observed: &'a BTreeMap<String, Value>,
    /// Normalised, see observed::live.
    live: BTreeMap<String, Value>,
    project: Option<&'a Value>,
    problem: String,
    labels: Labels,
    /// What the extensions in use need.
    extensions: ExtensionConfig,
}

/// What one location runs.
#[derive(Debug, Clone, Default)]
pub(crate) struct Member {
    location: String,
    site: String,
    /// Name in the distributed topology, and the folder it archives to.
    topology: String,
    /// Prefix of its composition resource names: "" or "recovery-".
    prefix: String,
    /// The protected site: bootstraps the database (initdb or restore).
    original: bool,
    instances: i64,
    sizing: Sizing,
    /// Observed objects in this location, keyed without the prefix.
    observed: BTreeMap<String, Value>,
    cluster: Option<Value>,
    status: ClusterStatus,
    /// spec.backup on the Project's bucket, or None for spec.backup itself.
    backup: Option<Backup>,
    /// The restore this member bootstraps from (original member only).
    restore: Option<MemberRestore>,
    /// Secret name here -> "<namespace>/<name>" to copy it from, else the
    /// same name in the XR's namespace.
    copy_from: BTreeMap<String, String>,
    placement: MemberPlacement,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct MemberRestore {
    store: Store,
    server_name: String,
    target_time: String,
}

/// Renders the desired state of a PostgresCluster.
pub fn compose(input: &Input) -> Result<Output> {
    let xr: Xr = decode(&input.xr);
    let name = xr.metadata.name.clone();
    let labels = Labels::from([
        ("app.kubernetes.io/managed-by".to_string(), "crossplane".to_string()),
        ("app.kubernetes.io/part-of".to_string(), "basis".to_string()),
        ("postgres.cndev.nl/postgrescluster".to_string(), name.clone()),
    ]);
    let mut c = Composition {
        input,
        spec: xr.spec.clone(),
        ns: xr.metadata.namespace.clone(),
        name,
        xr,
        observed: &input.observed,
        live: live(&input.observed),
        project: input.first(REQUIRED_PROJECT),
        problem: String::new(),
        labels,
        extensions: ExtensionConfig::default(),
    };
    c.compose()
}

impl Composition<'_> {
    fn resolved(&self, requirement: &str) -> bool {
        self.input.resolved(requirement)
    }

    /// The XR already composes more than the dashboard: there may be a
    /// database to protect.
    fn running(&self) -> bool {
        self.observed.len() > 1
    }

    fn set_problem(&mut self, msg: String) {
        if self.problem.is_empty() {
            self.problem = msg;
        }
    }

    fn compose(&mut self) -> Result<Output> {
        let (name, ns) = (self.name.clone(), self.ns.clone());

        // ---- sites: pinned in status.sites, else the Project's spec.locations
        let project_sites: Sites = self.project.and_then(|p| dig(p, &["spec", "locations"])).map(decode).unwrap_or_default();
        let protected = or(&self.xr.status.sites.protected, &project_sites.protected).to_string();
        let recovery = or(&self.xr.status.sites.recovery, &project_sites.recovery).to_string();
        let geo = self.spec.geo_replication.clone();
        // Geo replication switched off while the primary is in the recovery
        // site: keep the replica cluster and switch back first.
        let draining = !geo.enabled && !recovery.is_empty() && self.xr.status.primary_location == recovery;
        if protected.is_empty() {
            if self.resolved(REQUIRED_PROJECT) && self.running() {
                return Err(format!(
                    "PostgresCluster {ns}/{name} has composed resources but no site: neither status.sites nor Project {ns} says where it runs"
                ));
            }
            self.set_problem(format!("Namespace {ns} is not a Project with a protected location (Project spec.locations.protected)"));
        } else if geo.enabled && recovery.is_empty() {
            self.set_problem(format!("geoReplication is enabled, but Project {ns} has no recovery location (spec.locations.recovery)"));
        }

        // ---- backup store: the cluster's own, or the Project's bucket (pinned in status.backupStore)
        let project_bucket = self.spec.backup.enabled && self.spec.backup.destination_path.is_empty();
        let restore = self.spec.restore.clone();
        let restore_from_project = restore.as_ref().is_some_and(|r| r.source.destination_path.is_empty());
        let mut store = BackupStore::default();
        if project_bucket || restore_from_project {
            if let Some(s) = &self.xr.status.backup_store {
                store = s.clone();
            }
            lenient! {
                #[serde(rename_all = "camelCase")]
                struct ProjectBackup { ready: bool, destination_path: String, endpoint: String, namespace: String, region: String }
            }
            let pbs: ProjectBackup = self.project.and_then(|p| dig(p, &["status", "backup"])).map(decode).unwrap_or_default();
            if store.destination_path.is_empty() && pbs.ready && !pbs.destination_path.is_empty() {
                store = BackupStore { destination_path: pbs.destination_path, endpoint_url: pbs.endpoint,
                    namespace: or(&pbs.namespace, &ns).to_string(), region: !pbs.region.is_empty() };
            }
            if store.destination_path.is_empty() {
                // Never drop WAL archiving from a running cluster.
                if self.resolved(REQUIRED_PROJECT) && self.running() {
                    return Err(format!(
                        "PostgresCluster {ns}/{name} uses the Project's backup bucket, but neither status.backupStore nor Project {ns} status.backup says which"
                    ));
                }
                let verb = if project_bucket { "backup uses" } else { "restore reads from" };
                self.set_problem(format!("{verb} the backup bucket of Project {ns}, which isn't ready (Project spec.backup and COSI)"));
            }
        }

        let sizing = self.sizing()?;
        self.extensions = self.resolve_extensions();

        // ---- archive folders: the cluster's name, or a new one for a restored
        // cluster (never the folder it restores from)
        let mut server = name.clone();
        if restore.is_some() {
            server = format!("{name}-{}", trunc(or(&self.xr.metadata.uid, "restored"), 8));
        }

        // ---- members: the protected site, then the recovery site
        let mut members: Vec<Member> = vec![];
        if let Some(sizing) = &sizing
            && !protected.is_empty() && (!(project_bucket || restore_from_project) || !store.destination_path.is_empty()) {
                members.push(Member { location: protected.clone(), site: "protected".into(), topology: server.clone(),
                    prefix: String::new(), original: true, instances: self.spec.instances(), sizing: sizing.clone(), ..Default::default() });
                if !recovery.is_empty() && (geo.enabled || draining) {
                    members.push(Member { location: recovery.clone(), site: "recovery".into(),
                        topology: format!("{server}-{recovery}"), prefix: "recovery-".into(),
                        instances: or_i(geo.instances, self.spec.instances()), sizing: sizing.clone(), ..Default::default() });
                }
            }
        let distributed = members.len() > 1;
        // The Project's bucket as every member reaches it: through its copy of
        // the credentials, <name>-backup-s3.
        let mut bucket = Store::default();
        if !store.destination_path.is_empty() {
            bucket = Store {
                destination_path: store.destination_path.clone(),
                endpoint_url: store.endpoint_url.clone(),
                endpoint_ca: None,
                s3_credentials: Some(S3Credentials {
                    secret_name: format!("{name}-backup-s3"),
                    region_key: if store.region { "REGION".into() } else { String::new() },
                    ..Default::default()
                }),
            };
        }
        for m in &mut members {
            for (k, v) in &self.live {
                if m.original && !k.starts_with("recovery-") {
                    m.observed.insert(k.clone(), v.clone());
                } else if !m.original
                    && let Some(rest) = k.strip_prefix(&m.prefix) {
                        m.observed.insert(rest.to_string(), v.clone());
                    }
            }
            m.cluster = m.observed.get("cluster").cloned();
            m.status = read_cluster_status(m.cluster.as_ref());

            if !store.destination_path.is_empty() {
                let secret = bucket.s3_credentials.as_ref().map(|s| s.secret_name.clone()).unwrap_or_default();
                if project_bucket {
                    // The cluster's own settings (retention, schedule, ...) on the Project's bucket.
                    let mut backup = self.spec.backup.clone();
                    backup.destination_path = bucket.destination_path.clone();
                    backup.s3_credentials = bucket.s3_credentials.clone();
                    backup.endpoint_url = or(&bucket.endpoint_url, &backup.endpoint_url).to_string();
                    m.backup = Some(backup);
                }
                // Each location gets the credentials the Project unpacked for it.
                m.copy_from.insert(secret, format!("{}/backup-s3-{}", store.namespace, m.location));
            }
            if let (Some(r), true) = (&restore, m.original) {
                let src = if restore_from_project { bucket.clone() } else { r.source.store() };
                m.restore = Some(MemberRestore { store: src, server_name: r.source.server_name.clone(), target_time: r.target_time.clone() });
            }
        }

        // ---- which member is primary
        let by_location = |l: &str| members.iter().any(|m| m.location == l);
        let mut target = protected.clone();
        if or(&geo.primary_site, "protected") == "recovery" && geo.enabled && by_location(&recovery) {
            target = recovery.clone();
        }
        let mut prev = or(&self.xr.status.primary_location, &protected).to_string();
        if !by_location(&prev) {
            prev = protected.clone();
        }
        let tms: Vec<TopologyMember> = members
            .iter()
            .map(|m| TopologyMember { location: m.location.clone(), topology: m.topology.clone(), status: m.status.clone() })
            .collect();
        let placement = place(&tms, &target, &prev, or(&geo.promotion, SWITCHOVER), &self.xr.status.promotion_token);
        for m in &mut members {
            m.placement = placement.members.get(&m.location).cloned().unwrap_or_default();
        }

        // ---- emit every member's objects, then the dashboard
        let mut out = Output::default();
        for m in &members {
            for (key, obj) in self.member(m, &members, distributed)? {
                let k = format!("{}{key}", m.prefix);
                let w = self.wrap(m, &k, obj);
                out.composed.insert(k, w);
            }
        }
        let dash_uid = format!("cnpg-{}", trunc(&sha1hex(&format!("{ns}/{name}")), 20));
        if self.spec.monitoring.dashboard() {
            out.composed.insert("dashboard".into(), Composed {
                object: serde_json::to_value(self.dashboard(&dash_uid)).map_err(|e| e.to_string())?,
                ready: self.observed.contains_key("dashboard"),
            });
        }

        let fallback = Member { instances: self.spec.instances(), topology: server.clone(), ..Default::default() };
        let primary = members.iter().find(|m| m.location == placement.current).unwrap_or(&fallback);
        let (status, cond) = self.status(StatusInput {
            members: &members, primary, placement: &placement, protected: &protected, recovery: &recovery,
            draining: draining && distributed, store: &store, sizing: sizing.as_ref(), dash_uid: &dash_uid,
        });
        out.status = serde_json::to_value(status).map_err(|e| e.to_string())?;
        out.condition = cond;
        Ok(out)
    }

    /// spec.size (or spec.resources) resolved into what the instances run with.
    fn sizing(&mut self) -> Result<Option<Sizing>> {
        let (name, ns) = (self.name.clone(), self.ns.clone());
        let mut sizing: Option<Sizing> = None;
        if !self.spec.size.is_empty() {
            lenient! {
                struct ProfileSettings { parameters: Map<String, Value> }
            }
            lenient! {
                struct CatalogSize {
                    name: String,
                    resources: Map<String, Value>,
                    parameters: Map<String, Value>,
                    /// Per profile, settings over the size's.
                    profiles: BTreeMap<String, ProfileSettings>,
                }
            }
            lenient! {
                struct CatalogData { sizes: Vec<CatalogSize> }
            }
            lenient! {
                struct Catalog { data: CatalogData }
            }
            let catalog: Catalog = self.input.first(REQUIRED_SIZES).map(decode).unwrap_or_default();
            let profile = self.spec.profile().to_string();
            for s in &catalog.data.sizes {
                if s.name == self.spec.size {
                    let mut z = Sizing { size: self.spec.size.clone(), profile: String::new(), resources: s.resources.clone(), parameters: s.parameters.clone() };
                    if let Some(p) = s.profiles.get(&profile).filter(|p| !p.parameters.is_empty()) {
                        let mut params = s.parameters.clone();
                        for (k, v) in &p.parameters {
                            params.insert(k.clone(), v.clone());
                        }
                        z.profile = profile.clone();
                        z.parameters = params;
                    }
                    sizing = Some(z);
                }
            }
            let pinned = self.xr.status.sizing.clone();
            if sizing.is_none() {
                match pinned {
                    Some(p) if !p.resources.is_empty() => {
                        // A size retired from the catalog is fine for the clusters
                        // that have it; a change to one that isn't there is not applied.
                        if self.resolved(REQUIRED_SIZES) && p.size != self.spec.size {
                            self.set_problem(format!(
                                "size {} is not in the postgres-sizes catalog; the instances keep running as {}",
                                self.spec.size, or(&p.size, "before")
                            ));
                        }
                        sizing = Some(p);
                    }
                    _ if self.running() => {
                        // Never resize a running database to the defaults.
                        if self.resolved(REQUIRED_SIZES) {
                            return Err(format!(
                                "PostgresCluster {ns}/{name} has size {}, which is not in the postgres-sizes catalog, and no status.sizing to keep running with",
                                self.spec.size
                            ));
                        }
                    }
                    _ => self.set_problem(format!(
                        "size {} is not in the postgres-sizes catalog (EnvironmentConfig postgres-sizes, data.sizes)",
                        self.spec.size
                    )),
                }
            }
        } else {
            sizing = Some(Sizing { resources: self.spec.resources.clone(), ..Default::default() });
        }
        let Some(sizing) = sizing else { return Ok(None) };
        // The defaults, so status.sizing says what really runs.
        let r = Value::Object(sizing.resources.clone());
        let mut limits = Map::new();
        limits.insert("memory".into(), dig_or(&r, json!("1Gi"), &["limits", "memory"]));
        if let Some(cpu) = dig(&r, &["limits", "cpu"]).filter(|v| truthy(v)) {
            limits.insert("cpu".into(), cpu.clone());
        }
        let mut resources = Map::new();
        resources.insert("requests".into(), json!({
            "cpu": dig_or(&r, json!("500m"), &["requests", "cpu"]),
            "memory": dig_or(&r, json!("1Gi"), &["requests", "memory"]),
        }));
        resources.insert("limits".into(), Value::Object(limits));
        Ok(Some(Sizing { size: sizing.size, profile: sizing.profile, parameters: sizing.parameters, resources }))
    }
}

/// Sets the settings dst doesn't have (or has empty) from src.
pub(crate) fn fill_params(dst: &mut BTreeMap<String, String>, src: &Map<String, Value>) {
    for (k, v) in src {
        if dst.get(k).is_none_or(|x| x.is_empty()) {
            dst.insert(k.clone(), scalar(v));
        }
    }
}

/// A scalar from JSON the way the manifests carry it (quoted).
pub(crate) fn scalar(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => i.to_string(),
            (None, Some(f)) if f == (f as i64) as f64 => (f as i64).to_string(),
            (None, Some(f)) => fmt_g(f),
            _ => n.to_string(),
        },
        other => crate::common::gojson::sprint(other),
    }
}

/// dig with a default for a missing value.
fn dig_or(v: &Value, def: Value, path: &[&str]) -> Value {
    dig(v, path).filter(|v| !v.is_null()).cloned().unwrap_or(def)
}

/// Whether a value counts as set: not null, "", false or 0.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}

pub(crate) struct StatusInput<'a> {
    members: &'a [Member],
    primary: &'a Member,
    placement: &'a Placement,
    protected: &'a str,
    recovery: &'a str,
    /// Geo replication is off, the replica cluster stays until the primary is back.
    draining: bool,
    store: &'a BackupStore,
    sizing: Option<&'a Sizing>,
    dash_uid: &'a str,
}
