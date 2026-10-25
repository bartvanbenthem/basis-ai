//! Composes a Project (platform.cndev.nl/v1alpha1): a team's namespace on the
//! control plane and in each of its locations, with its own Prometheus and
//! Grafana, access, an optional quota and a backup bucket.
//!
//! On the control plane ("local", which runs no workloads):
//!
//!     namespace                   labels platform.cndev.nl/project and
//!                                 dashboards.paas.cndev.nl/scope = <name>; where the
//!                                 workload XRs live. Annotations record the locations
//!                                 for the admission policies and compositions
//!     prometheus-serviceaccount,  receives the samples of the project's locations
//!     prometheus, prometheus-pvc  (remote write), scrapes nothing
//!     grafana, grafana-datasource what the workloads' dashboards import into
//!     prometheus-remote-write     Ingress for /api/v1/write only, with
//!                                 prometheus.remoteWrite in project-defaults
//!     access-<i>                  RoleBinding per spec.access entry
//!     backup-bucketclass          BucketClass project-<name>-backups (COSI,
//!                                 Retain), unless spec.backup names one
//!     backup-bucket               BucketClaim backups
//!     backup-sa-<loc>,            per location: a ServiceAccount and BucketAccess
//!     backup-access-<loc>         with its own S3 keys, granted one at a time
//!     backup-s3-<loc>             those keys unpacked from COSI's BucketInfo JSON
//!     usage-location-<loc>        ClusterUsage: a Location can't go while used
//!     cost-rules, cost-dashboard  the project's cost and budget alerts (governance.rs)
//!
//! In each location (spec.locations.protected and .recovery), wrapped in
//! provider-kubernetes Objects named location-<loc>-<key>:
//!
//!     namespace                   never deleted by Crossplane
//!     prometheus-clusterrolebinding -> ClusterRole basis:project-prometheus
//!     prometheus-serviceaccount, prometheus, prometheus-pvc
//!                                 scrapes the namespace, the CNPG operator and the
//!                                 cluster metrics; remote write to the control plane
//!     access-<i>, quota, limitrange
//!     backup-check-s3, backup-check  every few minutes a write, read and delete of a
//!                                 test object in the bucket (status.backup.reachability)
//!
//! Cluster-wide settings come from the EnvironmentConfig project-defaults;
//! every key is optional. Namespaced objects are only rendered once their
//! namespace is observed.

mod governance;
mod member;

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::common::gojson::sprint;
use crate::common::util::{as_obj, as_str, bool_or, b64, dig, dig_opt, or, sha256hex, trunc, unb64};
use crate::common::{Composed, Condition, Input, Output, Requirement, Result};
use governance::{Governance, REQUIRED_PRICES};

const REQUIRED_DEFAULTS: &str = "defaults";
const REQUIRED_BACKUP_STORES: &str = "backup-stores";

/// What both requirements and compose derive from the XR and project-defaults.
struct Settings {
    xr: Value,
    spec: Map<String, Value>,
    env: Map<String, Value>,
    name: String,
    ns: String,
    site_locations: Vec<String>,
    bucket_on: bool,
    own_class: bool,
    bucket_class: String,
    access_class: String,
    cosi: Map<String, Value>,
    labels: Map<String, Value>,
    prom_enabled: bool,
    graf_enabled: bool,
    host: String,
    scheme: String,
    ingress: Map<String, Value>,
    remote_write: Map<String, Value>,
    rw_host: String,
    rw_url: String,
    has_remote: bool,
    gov: Governance,
}

impl Settings {
    fn new(xr: &Value, required: &BTreeMap<String, Vec<Value>>) -> Settings {
        let spec = as_obj(xr.get("spec"));
        let spec_v = Value::Object(spec.clone());
        let name = as_str(dig(xr, &["metadata", "name"])).to_string();
        let env = required.get(REQUIRED_DEFAULTS).and_then(|i| i.first()).and_then(|d| d.get("data")).and_then(Value::as_object).cloned().unwrap_or_default();
        let env_v = Value::Object(env.clone());
        let site_locations: Vec<String> = ["protected", "recovery"]
            .iter()
            .map(|site| as_str(dig(&spec_v, &["locations", site])).to_string())
            .filter(|l| !l.is_empty())
            .collect();
        let mut labels = Map::new();
        labels.insert("app.kubernetes.io/managed-by".into(), json!("crossplane"));
        labels.insert("app.kubernetes.io/part-of".into(), json!("basis"));
        labels.insert("platform.cndev.nl/project".into(), json!(name));

        let pb = as_obj(spec.get("backup"));
        let cosi = as_obj(dig(&env_v, &["backup", "cosi"]));
        // The project's own BucketClass (Retain) unless spec.backup names one;
        // project-defaults bucketClassName is the fallback without a driverName.
        let own_class = as_str(pb.get("bucketClassName")).is_empty() && !as_str(cosi.get("driverName")).is_empty();
        let mut bucket_class = or(as_str(pb.get("bucketClassName")), as_str(cosi.get("bucketClassName"))).to_string();
        if own_class {
            // COSI names the bucket <class><claim UID> (36 characters) and S3
            // allows 63, so the class gets 27.
            bucket_class = format!("project-{name}-backups");
            if bucket_class.len() > 27 {
                bucket_class = format!("prj-{}-{}", trunc(&name, 16).trim_end_matches('-'), trunc(&sha256hex(&name), 6));
            }
        }
        let gov = Governance::new(&spec, required);
        let access_class = or(as_str(pb.get("bucketAccessClassName")), as_str(cosi.get("bucketAccessClassName"))).to_string();
        let bucket_on = bool_or(pb.get("bucket"), true) && !bucket_class.is_empty() && !access_class.is_empty();

        let obs = Value::Object(as_obj(spec.get("observability")));
        let prom_enabled = bool_or(dig(&obs, &["prometheus", "enabled"]), true);
        let graf_enabled = bool_or(dig(&obs, &["grafana", "enabled"]), true);
        let ingress = as_obj(dig(&env_v, &["grafana", "ingress"]));
        let mut host = String::new();
        let tpl = as_str(ingress.get("hostTemplate"));
        if graf_enabled && bool_or(dig(&obs, &["grafana", "ingress"]), true) && !tpl.is_empty() {
            host = tpl.replace("{project}", &name);
        }
        let scheme = or(as_str(ingress.get("scheme")), "http").to_string();

        let has_remote = !site_locations.is_empty();
        let remote_write = as_obj(dig(&env_v, &["prometheus", "remoteWrite"]));
        let mut rw_host = String::new();
        let tpl = as_str(remote_write.get("hostTemplate"));
        if !tpl.is_empty() {
            rw_host = tpl.replace("{project}", &name);
        }
        let mut rw_url = String::new();
        if has_remote && prom_enabled && !rw_host.is_empty() {
            rw_url = format!("{}://{rw_host}/api/v1/write", or(as_str(remote_write.get("scheme")), "https"));
        }
        Settings {
            xr: xr.clone(), spec, env, ns: name.clone(), name, site_locations, bucket_on, own_class, bucket_class,
            access_class, cosi, labels, prom_enabled, graf_enabled, host, scheme, ingress, remote_write, rw_host,
            rw_url, has_remote, gov,
        }
    }

    fn spec_v(&self) -> Value {
        Value::Object(self.spec.clone())
    }

    fn meta(&self, name: &str) -> Value {
        json!({"name": name, "namespace": self.ns, "labels": self.labels})
    }
}

/// What the composition reads besides its composed resources. They depend on
/// project-defaults (the backup classes), so they settle on the second round.
pub fn requirements(input: &Input) -> BTreeMap<String, Requirement> {
    let s = Settings::new(&input.xr, &input.required);
    let mut reqs = BTreeMap::from([
        (REQUIRED_DEFAULTS.to_string(), Requirement::named("apiextensions.crossplane.io/v1beta1", "EnvironmentConfig", "", "project-defaults")),
        // The price catalog (governance.rs); optional.
        (REQUIRED_PRICES.to_string(), Requirement::named("apiextensions.crossplane.io/v1beta1", "EnvironmentConfig", "", "basis-prices")),
    ]);
    for l in &s.site_locations {
        reqs.insert(format!("location-{l}"), Requirement::named("platform.cndev.nl/v1alpha1", "Location", "", l));
        if s.bucket_on {
            // What COSI wrote for this location's BucketAccess.
            reqs.insert(format!("cosi-{l}"), Requirement::named("v1", "Secret", &s.ns, &format!("cosi-backups-{l}")));
        }
    }
    if s.bucket_on {
        // The PostgresClusters' backup stores, for the inventory of the bucket.
        reqs.insert(REQUIRED_BACKUP_STORES.into(), Requirement {
            api_version: "kubernetes.m.crossplane.io/v1alpha1".into(),
            kind: "Object".into(),
            namespace: Some(s.ns.clone()),
            name: None,
            labels: Some(BTreeMap::from([("postgres.cndev.nl/backup-store".to_string(), "true".to_string())])),
        });
    }
    reqs
}

/// The control plane ("local") or one of the project's locations.
struct Member {
    location: String,
    site: String,
    prefix: String,
    observed: BTreeMap<String, Value>,
}

impl Member {
    fn local(&self) -> bool {
        self.location == "local"
    }
}

/// What each member reports back for the XR's status.
#[derive(Default)]
struct MemberStatus {
    location: String,
    site: String,
    waiting: Vec<String>,
    problem: String,
    backup_check: Map<String, Value>,
}

/// What a location's backup check needs: the bucket and its keys.
struct BackupCheck {
    endpoint: String,
    bucket: String,
    image: String,
    schedule: String,
}

/// Renders the desired state of a Project.
pub fn compose(input: &Input) -> Result<Output> {
    let s = Settings::new(&input.xr, &input.required);
    let mut out = Output::default();
    let observed = &input.observed;
    let spec_v = s.spec_v();

    // Observed, normalised: an Object stands for the object it manages.
    let mut live: BTreeMap<String, Value> = BTreeMap::new();
    for (k, v) in observed {
        if as_str(v.get("kind")) == "Object" && as_str(v.get("apiVersion")).starts_with("kubernetes.m.crossplane.io/") {
            if let Some(m) = dig(v, &["status", "atProvider", "manifest"]).filter(|m| m.as_object().is_some_and(|m| !m.is_empty())) {
                live.insert(k.clone(), m.clone());
            }
            continue;
        }
        live.insert(k.clone(), v.clone());
    }

    let mut members = vec![Member { location: "local".into(), site: String::new(), prefix: String::new(), observed: BTreeMap::new() }];
    for site in ["protected", "recovery"] {
        let l = as_str(dig(&spec_v, &["locations", site]));
        if !l.is_empty() {
            members.push(Member { location: l.into(), site: site.into(), prefix: format!("location-{l}-"), observed: BTreeMap::new() });
        }
    }
    // The Location objects of the other locations.
    let mut registered: BTreeMap<String, bool> = BTreeMap::new();
    let mut unschedulable: Vec<String> = vec![];
    for m in &members[1..] {
        if let Some(item) = input.first(&format!("location-{}", m.location)) {
            registered.insert(m.location.clone(), true);
            if dig(item, &["spec", "schedulable"]).and_then(Value::as_bool) == Some(false) {
                unschedulable.push(m.location.clone());
            }
        }
    }
    // Objects live in the project namespace here: none before it exists.
    let hub_ns = live.contains_key("namespace");

    // What each location's backup check needs: the bucket and its keys.
    let mut checks: BTreeMap<String, BackupCheck> = BTreeMap::new();
    let check_cfg = as_obj(dig(&Value::Object(s.env.clone()), &["backup", "check"]));
    let bucket_name = as_str(dig_opt(observed.get("backup-bucket"), &["status", "bucketName"])).to_string();
    if s.bucket_on && hub_ns && bool_or(check_cfg.get("enabled"), true) && !bucket_name.is_empty() {
        for loc in &s.site_locations {
            if let Some(s3) = cosi_s3(input.required.get(&format!("cosi-{loc}")))
                && !as_str(s3.get("endpoint")).is_empty() && !as_str(s3.get("accessKeyID")).is_empty() && !as_str(s3.get("accessSecretKey")).is_empty() {
                    checks.insert(loc.clone(), BackupCheck {
                        endpoint: as_str(s3.get("endpoint")).into(),
                        bucket: bucket_name.clone(),
                        image: or(as_str(check_cfg.get("image")), "curlimages/curl:8.16.0").into(),
                        schedule: or(as_str(check_cfg.get("schedule")), "*/5 * * * *").into(),
                    });
                }
        }
    }

    // Every member's objects.
    let mut statuses: Vec<MemberStatus> = vec![];
    for m in &mut members {
        m.observed = live.iter().filter_map(|(k, v)| k.strip_prefix(&m.prefix).map(|rest| (rest.to_string(), v.clone()))).collect();
        let (objects, mut st) = s.member(m, &unschedulable, checks.get(&m.location));
        if !m.local() && !hub_ns {
            st.waiting = vec!["the project namespace on the control plane".into()];
        }
        if !m.local() && !registered.contains_key(&m.location) {
            st.problem = format!("no Location {}; register the cluster first", m.location);
        }
        statuses.push(st);
        if !m.local() && !hub_ns {
            continue;
        }
        for o in objects {
            let key = format!("{}{}", m.prefix, o.key);
            if m.local() {
                out.composed.insert(key, Composed { object: o.manifest, ready: o.ready });
                continue;
            }
            let w = s.wrap(&key, &m.location, o);
            out.composed.insert(key, w);
        }
    }

    // The backup bucket: claim, an access per location, its keys unpacked.
    let mut bucket: Option<Map<String, Value>> = None;
    let mut ungranted: Vec<String> = vec![];
    if s.bucket_on && s.own_class {
        // Retain: deleting the Project (or the claim) leaves the bucket and its backups.
        let mut bc = json!({
            "apiVersion": "objectstorage.k8s.io/v1alpha1", "kind": "BucketClass",
            "metadata": {"name": s.bucket_class, "labels": s.labels},
            "driverName": as_str(s.cosi.get("driverName")), "deletionPolicy": "Retain",
        });
        let params = as_obj(s.cosi.get("parameters"));
        if !params.is_empty() {
            bc["parameters"] = Value::Object(params.iter().map(|(k, v)| (k.clone(), json!(sprint(v)))).collect());
        }
        out.composed.insert("backup-bucketclass".into(), Composed { object: bc, ready: observed.contains_key("backup-bucketclass") });
    }
    if s.bucket_on {
        bucket = Some(json!({"ready": false, "namespace": s.ns}).as_object().cloned().unwrap_or_default());
    }
    if s.bucket_on && hub_ns {
        let claim = observed.get("backup-bucket");
        let bucket_name = as_str(dig_opt(claim, &["status", "bucketName"])).to_string();
        let bucket_ready = bool_or(dig_opt(claim, &["status", "bucketReady"]), false) && !bucket_name.is_empty();
        let mut credentials = Map::new();
        let (mut endpoint, mut region) = (String::new(), String::new());
        out.composed.insert("backup-bucket".into(), Composed { ready: bucket_ready, object: json!({
            "apiVersion": "objectstorage.k8s.io/v1alpha1", "kind": "BucketClaim",
            "metadata": s.meta("backups"),
            "spec": {"bucketClassName": s.bucket_class, "protocols": ["S3"]},
        })});
        // One grant at a time: concurrent grants race on the Bucket's
        // finalizer, and a grant retried after a conflict fails for good.
        let mut granting = false;
        for loc in &s.site_locations {
            let access = observed.get(&format!("backup-access-{loc}"));
            let granted = bool_or(dig_opt(access, &["status", "accessGranted"]), false);
            // The COSI sidecar refuses an IAM-type access class without a
            // ServiceAccount; nothing runs as it.
            let mut sa = s.meta(&format!("backups-{loc}"));
            sa["annotations"] = json!({"platform.cndev.nl/location": loc});
            out.composed.insert(format!("backup-sa-{loc}"), Composed { ready: true, object: json!({
                "apiVersion": "v1", "kind": "ServiceAccount", "metadata": sa, "automountServiceAccountToken": false,
            })});
            if !granted {
                ungranted.push(loc.clone());
            }
            if access.is_some() || !granting {
                if !granted {
                    granting = true;
                }
                let mut meta = s.meta(&format!("backups-{loc}"));
                meta["annotations"] = json!({"platform.cndev.nl/location": loc});
                out.composed.insert(format!("backup-access-{loc}"), Composed { ready: granted, object: json!({
                    "apiVersion": "objectstorage.k8s.io/v1alpha1", "kind": "BucketAccess", "metadata": meta,
                    "spec": {"bucketClaimName": "backups", "bucketAccessClassName": s.access_class,
                        "credentialsSecretName": format!("cosi-backups-{loc}"), "serviceAccountName": format!("backups-{loc}"), "protocol": "S3"},
                })});
            }
            // COSI's Secret holds one BucketInfo JSON document; CNPG needs
            // the keys as Secret keys of their own.
            if let Some(s3) = cosi_s3(input.required.get(&format!("cosi-{loc}")))
                && !as_str(s3.get("accessKeyID")).is_empty() && !as_str(s3.get("accessSecretKey")).is_empty() {
                    endpoint = as_str(s3.get("endpoint")).into();
                    region = as_str(s3.get("region")).into();
                    credentials.insert(loc.clone(), json!(format!("backup-s3-{loc}")));
                    let mut data = json!({"ACCESS_KEY_ID": b64(as_str(s3.get("accessKeyID"))), "ACCESS_SECRET_KEY": b64(as_str(s3.get("accessSecretKey")))});
                    let r = as_str(s3.get("region"));
                    if !r.is_empty() {
                        data["REGION"] = json!(b64(r));
                    }
                    let mut meta = s.meta(&format!("backup-s3-{loc}"));
                    meta["annotations"] = json!({"platform.cndev.nl/location": loc});
                    out.composed.insert(format!("backup-s3-{loc}"), Composed { ready: true, object: json!({
                        "apiVersion": "v1", "kind": "Secret", "metadata": meta, "type": "Opaque", "data": data,
                    })});
                }
        }
        let ready = bucket_ready && credentials.len() == s.site_locations.len() && !endpoint.is_empty();
        bucket = Some(json!({"ready": ready, "bucket": bucket_name, "endpoint": endpoint, "region": region,
            "namespace": s.ns, "credentials": credentials}).as_object().cloned().unwrap_or_default());
    }

    let servers = s.inventory(bucket.as_ref(), input.required.get(REQUIRED_BACKUP_STORES).map(Vec::as_slice).unwrap_or(&[]));

    // A ClusterUsage per registered location: no deleting a Location a Project uses.
    for loc in registered.keys() {
        out.composed.insert(format!("usage-location-{loc}"), Composed { ready: true, object: json!({
            "apiVersion": "protection.crossplane.io/v1beta1", "kind": "ClusterUsage",
            "metadata": {"name": format!("project-{}-location-{loc}", s.name), "labels": s.labels},
            "spec": {
                "of": {"apiVersion": "platform.cndev.nl/v1alpha1", "kind": "Location", "resourceRef": {"name": loc}},
                "reason": format!("Project {} runs databases in this location; delete the Project first", s.name),
            },
        })});
    }

    s.status(&mut out, &statuses, bucket.as_ref(), &ungranted, &servers);
    Ok(out)
}

/// spec.secretS3 of the BucketInfo in a COSI Secret, None without one.
fn cosi_s3(items: Option<&Vec<Value>>) -> Option<Map<String, Value>> {
    let item = items?.first()?;
    let Some(raw) = unb64(as_str(dig(item, &["data", "BucketInfo"]))) else {
        return Some(Map::new());
    };
    let Ok(info) = serde_json::from_str::<Value>(&raw) else {
        return Some(Map::new());
    };
    if !info.is_object() {
        return Some(Map::new());
    }
    Some(as_obj(dig(&info, &["spec", "secretS3"])))
}

/// sprig's notion of an empty value, which its merge fills.
fn empty(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Bool(b)) => !b,
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        _ => false,
    }
}

impl Settings {
    /// The inventory of the bucket's backup folders: the last status's
    /// entries (inactive unless still seen), updated from the
    /// PostgresClusters' ObjectStores that archive to this bucket.
    fn inventory(&self, bucket: Option<&Map<String, Value>>, stores: &[Value]) -> BTreeMap<String, Map<String, Value>> {
        let mut servers: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
        if let Some(prev) = dig(&self.xr, &["status", "backup", "servers"]).and_then(Value::as_array) {
            for p in prev {
                let Some(e) = p.as_object() else { continue };
                let mut entry = e.clone();
                entry.insert("active".into(), json!(false));
                servers.insert(as_str(e.get("serverName")).into(), entry);
            }
        }
        let name = bucket.map(|b| as_str(b.get("bucket"))).unwrap_or("");
        if name.is_empty() {
            return servers;
        }
        let path = format!("s3://{name}/barman");
        for o in stores {
            let os = dig(o, &["status", "atProvider", "manifest"]).filter(|v| v.is_object()).cloned().unwrap_or(Value::Null);
            let ann = as_obj(dig(&os, &["metadata", "annotations"]));
            let srv = as_str(ann.get("postgres.cndev.nl/server-name")).to_string();
            if srv.is_empty() || as_str(dig(&os, &["spec", "configuration", "destinationPath"])) != path {
                continue;
            }
            let mut e = servers.get(&srv).cloned().unwrap_or_default();
            let version: i64 = as_str(ann.get("postgres.cndev.nl/postgres-version")).parse().unwrap_or(0);
            // New values win; empty ones keep what the last status had.
            let new = [
                ("serverName", json!(srv)),
                ("active", json!(true)),
                ("cluster", json!(as_str(dig(o, &["metadata", "labels", "postgres.cndev.nl/postgrescluster"])))),
                ("location", json!(as_str(dig(o, &["metadata", "annotations", "platform.cndev.nl/location"])))),
                ("postgresVersion", json!(version)),
                ("database", json!(as_str(ann.get("postgres.cndev.nl/database")))),
                ("owner", json!(as_str(ann.get("postgres.cndev.nl/database-owner")))),
            ];
            for (k, v) in new {
                let keep_old = e.contains_key(k) && empty(Some(&v)) && !empty(e.get(k));
                if !keep_old {
                    e.insert(k.into(), v);
                }
            }
            let window = as_obj(dig(&os, &["status", "serverRecoveryWindow", &srv]));
            if !empty(window.get("firstRecoverabilityPoint")) {
                e.insert("firstRecoverabilityPoint".into(), window["firstRecoverabilityPoint"].clone());
            }
            if !empty(window.get("lastSuccessfulBackupTime")) {
                e.insert("lastSuccessfulBackup".into(), window["lastSuccessfulBackupTime"].clone());
            }
            servers.insert(srv, e);
        }
        servers
    }

    fn status(&self, out: &mut Output, statuses: &[MemberStatus], bucket: Option<&Map<String, Value>>, ungranted: &[String],
        servers: &BTreeMap<String, Map<String, Value>>) {
        let mut waiting: Vec<String> = vec![];
        let mut problems: Vec<String> = vec![];
        for st in statuses {
            if !st.problem.is_empty() {
                problems.push(st.problem.clone());
            }
            if st.location == "local" {
                waiting.extend(st.waiting.iter().cloned());
                continue;
            }
            for w in &st.waiting {
                waiting.push(format!("{w} in {}", st.location));
            }
        }
        if bucket.is_some_and(|b| !bool_or(b.get("ready"), false)) {
            waiting.push("the backup bucket (COSI)".into());
        } else if !ungranted.is_empty() {
            waiting.push(format!("COSI to grant backup bucket access in {}", ungranted.join(", ")));
        }
        let ready = waiting.is_empty() && problems.is_empty();
        let mut msg = if !problems.is_empty() {
            problems.join("; ")
        } else if !ready {
            format!("Waiting for {}", waiting.join(", "))
        } else {
            format!("Project {} is ready", self.name)
        };
        if ready && self.has_remote && self.prom_enabled && self.rw_url.is_empty() {
            msg = format!("Project {} is ready; metrics stay in its locations and Grafana shows none (no prometheus.remoteWrite in project-defaults)", self.name);
        }
        if self.gov.expired {
            let expiry = format!("expired on {}: it keeps running, but nothing new can be created in it; extend spec.expiresAt or delete it", self.gov.expires_at);
            if ready {
                msg = format!("Project {} {expiry}", self.name);
            } else {
                msg = format!("{msg}; {expiry}");
            }
        }

        let mut locations = vec![];
        let mut reach = vec![];
        for st in &statuses[1..] {
            let mut m = st.problem.clone();
            if m.is_empty() {
                m = if st.waiting.is_empty() { "ready".into() } else { format!("waiting for {}", st.waiting.join(", ")) };
            }
            locations.push(json!({"location": st.location, "site": st.site,
                "ready": st.waiting.is_empty() && st.problem.is_empty(), "message": m}));
            if !st.backup_check.is_empty() {
                let mut r = st.backup_check.clone();
                r.insert("location".into(), json!(st.location));
                reach.push(Value::Object(r));
            }
        }
        let mut status = json!({"ready": ready, "message": msg, "namespace": self.ns, "locations": locations, "governance": self.gov.status()});
        if let Some(bucket) = bucket {
            let mut b = json!({"ready": bucket.get("ready").cloned().unwrap_or(Value::Null),
                "namespace": bucket.get("namespace").cloned().unwrap_or(Value::Null)});
            let name = as_str(bucket.get("bucket"));
            if !name.is_empty() {
                b["bucket"] = json!(name);
                b["destinationPath"] = json!(format!("s3://{name}/barman"));
            }
            for k in ["endpoint", "region"] {
                let v = as_str(bucket.get(k));
                if !v.is_empty() {
                    b[k] = json!(v);
                }
            }
            let c = as_obj(bucket.get("credentials"));
            if !c.is_empty() {
                b["credentials"] = Value::Object(c);
            }
            if !reach.is_empty() {
                b["reachability"] = json!(reach);
            }
            if !servers.is_empty() {
                b["servers"] = json!(servers.values().collect::<Vec<_>>());
            }
            status["backup"] = b;
        }
        if self.prom_enabled {
            let mut p = json!({"url": format!("http://prometheus-operated.{}.svc:9090", self.ns)});
            if !self.rw_url.is_empty() {
                p["remoteWriteUrl"] = json!(self.rw_url);
            }
            status["prometheus"] = p;
        }
        if self.graf_enabled {
            let mut g = json!({
                "internalUrl": format!("http://grafana-service.{}.svc:3000", self.ns),
                "adminSecret": "grafana-admin-credentials",
                "instanceSelector": {"dashboards.paas.cndev.nl/scope": self.ns},
            });
            if !self.host.is_empty() {
                g["url"] = json!(format!("{}://{}", self.scheme, self.host));
            }
            status["grafana"] = g;
        }
        out.status = status;
        out.condition = Condition { status: ready, reason: if ready { "Available" } else { "Provisioning" }.into(), message: msg };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::util::set_now;

    fn xr(name: &str, spec: &str, status: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"apiVersion":"platform.cndev.nl/v1alpha1","kind":"Project","metadata":{{"name":"{name}"}},"spec":{spec},"status":{status}}}"#
        )).unwrap()
    }

    fn cosi_defaults() -> BTreeMap<String, Vec<Value>> {
        BTreeMap::from([(REQUIRED_DEFAULTS.to_string(), vec![json!({"data": {"backup": {"cosi": {
            "driverName": "cosi.example.com", "bucketAccessClassName": "s3-keys"}}}})])])
    }

    fn reqs(xr: Value, required: BTreeMap<String, Vec<Value>>) -> BTreeMap<String, Requirement> {
        requirements(&Input { xr, required, ..Default::default() })
    }

    #[test]
    fn requirements_settle_with_project_defaults() {
        let x = xr("demo", r#"{"locations":{"protected":"dc-a","recovery":"dc-b"}}"#, "{}");
        // First round: project-defaults isn't resolved yet, so no bucket.
        let first = reqs(x.clone(), BTreeMap::new());
        for k in ["defaults", "location-dc-a", "location-dc-b"] {
            assert!(first.contains_key(k), "first round misses {k}");
        }
        assert!(!first.contains_key("cosi-dc-a"), "first round asks for COSI secrets without project-defaults");
        // Second round: with COSI classes the bucket's Secrets and stores follow.
        let second = reqs(x, cosi_defaults());
        let r = &second["cosi-dc-b"];
        assert_eq!((r.namespace.as_deref(), r.name.as_deref()), (Some("demo"), Some("cosi-backups-dc-b")));
        let r = &second[REQUIRED_BACKUP_STORES];
        assert_eq!(r.labels.as_ref().unwrap()["postgres.cndev.nl/backup-store"], "true");
        assert!(r.name.is_none());
    }

    #[test]
    fn bucket_class_name() {
        for (name, want) in [
            ("payments", "project-payments-backups".to_string()),
            ("a-very-long-project-name", format!("prj-a-very-long-proj-{}", trunc(&sha256hex("a-very-long-project-name"), 6))),
            // The 16-character cut ends on "-": dropped.
            ("abcdefghijklmno-pqrs", format!("prj-abcdefghijklmno-{}", trunc(&sha256hex("abcdefghijklmno-pqrs"), 6))),
        ] {
            let s = Settings::new(&xr(name, r#"{"locations":{"protected":"dc-a"}}"#, "{}"), &cosi_defaults());
            assert_eq!(s.bucket_class, want, "{name}");
            assert!(s.bucket_class.len() <= 27);
        }
    }

    #[test]
    fn inventory_keeps_what_a_store_no_longer_says() {
        let s = Settings::new(&xr("demo", r#"{"locations":{"protected":"dc-a"}}"#, r#"{"backup":{"servers":[
            {"serverName":"orders-db","active":true,"database":"orders","postgresVersion":17,"firstRecoverabilityPoint":"t0"},
            {"serverName":"gone-db","active":true,"database":"old"}]}}"#), &cosi_defaults());
        let store = json!({
            "metadata": {"labels": {"postgres.cndev.nl/postgrescluster": "orders-db"}, "annotations": {"platform.cndev.nl/location": "dc-a"}},
            "status": {"atProvider": {"manifest": {
                "metadata": {"annotations": {"postgres.cndev.nl/server-name": "orders-db", "postgres.cndev.nl/postgres-version": "18"}},
                "spec": {"configuration": {"destinationPath": "s3://bkt/barman"}},
                "status": {"serverRecoveryWindow": {"orders-db": {"lastSuccessfulBackupTime": "t1"}}},
            }}},
        });
        let bucket = json!({"bucket": "bkt"}).as_object().cloned().unwrap();
        let servers = s.inventory(Some(&bucket), &[store]);
        let orders = &servers["orders-db"];
        assert_eq!(orders["active"], true);
        assert_eq!(orders["postgresVersion"], 18);
        assert_eq!(orders["cluster"], "orders-db");
        // Not in the store's annotations any more: the last status's value stays.
        assert_eq!(orders["database"], "orders");
        assert_eq!(orders["firstRecoverabilityPoint"], "t0");
        assert_eq!(orders["lastSuccessfulBackup"], "t1");
        let gone = &servers["gone-db"];
        assert_eq!(gone["active"], false);
        assert_eq!(gone["database"], "old");
    }

    #[test]
    fn locations_wait_for_the_hub_namespace() {
        let out = compose(&Input { xr: xr("demo", r#"{"locations":{"protected":"dc-a"}}"#, "{}"),
            required: BTreeMap::from([("location-dc-a".to_string(), vec![json!({"spec": {}})])]), ..Default::default() }).unwrap();
        assert!(!out.composed.contains_key("location-dc-a-namespace"), "objects in dc-a before the project namespace exists on the control plane");
        assert!(out.composed.contains_key("usage-location-dc-a"), "no ClusterUsage for the registered location");
        assert!(!out.condition.status);
        assert_eq!(out.status["message"], "Waiting for namespace, Prometheus, Grafana, the project namespace on the control plane in dc-a");
    }

    fn prices() -> Value {
        json!({"data": {"currency": "EUR", "cpu": 73.0, "memory": 7.3, "storage": 0.73, "loadBalancer": 14.6,
            "tokens": {"default": {"input": 1.0, "output": 2.0}, "models": [{"model": "openai/gpt-oss-120b", "input": 0.5, "output": 1.0}]}}})
    }

    /// A project whose namespace exists, with the price catalog.
    fn governed(spec: &str) -> Output {
        compose(&Input {
            xr: xr("demo", spec, "{}"),
            observed: BTreeMap::from([("namespace".to_string(), json!({"status": {"phase": "Active"}}))]),
            required: BTreeMap::from([(REQUIRED_PRICES.to_string(), vec![prices()]), ("location-dc-a".to_string(), vec![json!({"spec": {}})])]),
        }).unwrap()
    }

    fn at(t: &str) {
        set_now(Some(chrono::DateTime::parse_from_rfc3339(t).unwrap().into()));
    }

    #[test]
    fn governance_labels_and_status() {
        at("2026-10-22T12:00:00Z");
        let out = governed(r#"{"locations":{"protected":"dc-a"},"classification":"confidential","environment":"sandbox",
            "costCenter":"CC 4711","budget":{"monthly":2500,"monthlyTokens":50000000},"expiresAt":"2026-10-22"}"#);
        let labels = &out.composed["namespace"].object["metadata"]["labels"];
        assert_eq!(labels["platform.cndev.nl/classification"], "confidential");
        assert_eq!(labels["platform.cndev.nl/environment"], "sandbox");
        assert_eq!(labels["platform.cndev.nl/cost-center"], "CC-4711");
        // The last day itself isn't over yet.
        assert!(labels.get("platform.cndev.nl/expired").is_none(), "expired on its last day");
        let g = &out.status["governance"];
        assert_eq!(g["costCenter"], "CC 4711");
        assert_eq!(g["expired"], false);
        assert_eq!(g["currency"], "EUR");
        assert_eq!(g["budget"]["monthly"], 2500.0);

        at("2026-10-23T00:00:01Z");
        let out = governed(r#"{"locations":{"protected":"dc-a"},"expiresAt":"2026-10-22"}"#);
        set_now(None);
        let labels = &out.composed["namespace"].object["metadata"]["labels"];
        assert_eq!(labels["platform.cndev.nl/expired"], "true");
        assert!(out.status["message"].as_str().unwrap().contains("expired on 2026-10-22"));
        // Defaults: internal, production.
        assert_eq!(labels["platform.cndev.nl/classification"], "internal");
        assert_eq!(labels["platform.cndev.nl/environment"], "production");
    }

    #[test]
    fn cost_rules() {
        let out = governed(r#"{"locations":{"protected":"dc-a"},"budget":{"monthly":2500}}"#);
        let s = serde_json::to_string(&out.composed.get("cost-rules").expect("no cost rules with the price catalog").object).unwrap();
        for want in [
            // 73 per vCPU-month is 0.1 per hour; running pods only.
            r#"kube_pod_container_resource_requests{namespace=\"demo\",resource=\"cpu\"} and on (namespace, pod, site) (kube_pod_status_phase{namespace=\"demo\",phase=\"Running\"} == 1)) * 0.1"#,
            r#"count by (namespace, site) (kube_service_spec_type{namespace=\"demo\",type=\"LoadBalancer\"}) * 0.02"#,
            // The priced model, and every other model at the default price.
            r#"gen_ai_request_model=\"openai/gpt-oss-120b\"} * 0.5 or basis:tokens_per_hour{namespace=\"demo\",gen_ai_token_type=\"output\",gen_ai_request_model=\"openai/gpt-oss-120b\"} * 1)"#,
            r#"gen_ai_request_model!~\"openai/gpt-oss-120b\"} * 1 or"#,
            r#""alert":"BasisBudgetForecastExceeded""#,
            r#""expr":"basis:cost_monthly_forecast{namespace=\"demo\"} > 2500""#,
        ] {
            assert!(s.contains(want), "cost rules lack {want}\n{s}");
        }
        assert!(!s.contains("BasisTokenBudget"), "token alerts without budget.monthlyTokens");
        assert!(out.composed.contains_key("cost-dashboard"), "no cost dashboard");
        // The control-plane Prometheus evaluates them.
        assert_eq!(out.composed["prometheus"].object["spec"]["ruleNamespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"], "demo");

        // Without the catalog: no cost rules, no rule selector on the control plane.
        let bare = compose(&Input { xr: xr("demo", r#"{"locations":{"protected":"dc-a"}}"#, "{}"),
            observed: BTreeMap::from([("namespace".to_string(), json!({"status": {"phase": "Active"}}))]), ..Default::default() }).unwrap();
        assert!(!bare.composed.contains_key("cost-rules"), "cost rules without basis-prices");
        assert!(bare.composed["prometheus"].object["spec"].get("ruleSelector").is_none(), "rule selector on the control plane without cost rules");
        assert_eq!(reqs(xr("demo", "{}", "{}"), BTreeMap::new())[REQUIRED_PRICES].name.as_deref(), Some("basis-prices"));
    }
}
