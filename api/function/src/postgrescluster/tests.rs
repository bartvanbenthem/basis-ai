//! The render tests (tests/render) cover the composition end to end; these
//! cover what they can't: the refusals, and the details the fixtures don't vary.

use serde_json::{Value, json};
use std::collections::BTreeMap;

use super::member::{ALERT_RULES_SOURCE, dashboard_json, queries_for};
use super::observed::ClusterStatus;
use super::topology::{FAILOVER, MemberPlacement, Role, SWITCHOVER, TopologyMember, place};
use super::*;
use crate::common::Output;

const AMS: &str = "onprem-ams";
const RTM: &str = "si-ske-demo";

const XR: &str = "
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata: {name: orders-db, namespace: payments, uid: 0f3a9c1e-1111-2222-3333-444444444444}
spec: {}
";

fn obj(y: &str) -> Value {
    serde_yaml::from_str(y).unwrap()
}

fn xr(spec: &str) -> Value {
    let mut x = obj(XR);
    x["spec"] = obj(spec);
    x
}

fn project(y: &str) -> Vec<Value> {
    vec![obj(&format!("apiVersion: platform.cndev.nl/v1alpha1\nkind: Project\nmetadata: {{name: payments}}\n{y}"))]
}

fn protected() -> Vec<Value> {
    project(&format!("spec: {{locations: {{protected: {RTM}}}}}"))
}

/// The observed state of a cluster that exists: the dashboard and its Cluster.
fn running() -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("dashboard".into(), obj("apiVersion: grafana.integreatly.org/v1beta1\nkind: GrafanaDashboard")),
        ("cluster".into(), obj("apiVersion: kubernetes.m.crossplane.io/v1alpha1\nkind: Object")),
    ])
}

fn required(r: &[(&str, Vec<Value>)]) -> BTreeMap<String, Vec<Value>> {
    r.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn cluster_spec(out: &Output, key: &str) -> Value {
    let c = out.composed.get(key).unwrap_or_else(|| panic!("no {key} composed"));
    c.object["spec"]["forProvider"]["manifest"]["spec"].clone()
}

fn as_json(v: &Value) -> String {
    serde_json::to_string(v).unwrap()
}

#[test]
fn compose_refuses() {
    let cases: Vec<(&str, Input, &str)> = vec![
        ("no site for a running cluster",
         Input { xr: obj(XR), observed: running(), required: required(&[(REQUIRED_PROJECT, vec![])]) },
         "has composed resources but no site"),
        ("no site yet, Project not resolved", Input { xr: obj(XR), observed: running(), required: BTreeMap::new() }, ""),
        ("no site for a new cluster is a problem, not a refusal",
         Input { xr: obj(XR), required: required(&[(REQUIRED_PROJECT, vec![])]), ..Default::default() }, ""),
        ("Project bucket gone for a running cluster",
         Input { xr: xr("backup: {enabled: true}"), observed: running(), required: required(&[(REQUIRED_PROJECT, protected())]) },
         "uses the Project's backup bucket"),
        ("size gone from the catalog with nothing pinned",
         Input { xr: xr("size: huge"), observed: running(), required: required(&[
             (REQUIRED_PROJECT, protected()),
             (REQUIRED_SIZES, vec![obj("data: {sizes: [{name: s}]}")]),
         ]) },
         "is not in the postgres-sizes catalog, and no status.sizing"),
    ];
    for (name, input, want) in cases {
        match compose(&input) {
            Ok(out) if want.is_empty() => {
                // A new or unplaced cluster: only the dashboard, never a
                // Cluster without a location.
                assert!(!out.composed.contains_key("cluster"), "{name}: composed a Cluster without a site");
            }
            Ok(_) => panic!("{name}: no error, want a refusal containing {want:?}"),
            Err(e) if want.is_empty() => panic!("{name}: unexpected error: {e}"),
            Err(e) => assert!(e.contains(want), "{name}: error {e}, want a refusal containing {want:?}"),
        }
    }
}

#[test]
fn parameter_precedence() {
    let out = compose(&Input {
        xr: xr("
size: m
postgresql: {parameters: {work_mem: 64MB, empty: \"\"}}
database: {extensions: [pg_stat_statements]}"),
        required: required(&[
            (REQUIRED_PROJECT, protected()),
            (REQUIRED_SIZES, vec![obj("data: {sizes: [{name: m, resources: {requests: {cpu: 2, memory: 8Gi}},
  parameters: {work_mem: 16MB, shared_buffers: 2GB, max_connections: 200, empty: from-size}}]}")]),
            (REQUIRED_EXTENSIONS, vec![obj("data: {extensions: [
  {name: pg_stat_statements, parameters: {pg_stat_statements.track: top, shared_buffers: 1GB}},
  {name: pg_trgm, parameters: {never: used}}]}")]),
        ]),
        ..Default::default()
    })
    .unwrap();
    let spec = cluster_spec(&out, "cluster");
    // The spec's settings over the size's over the extensions'; an empty one
    // counts as unset; numbers from the catalog become strings.
    assert_eq!(
        as_json(&spec["postgresql"]["parameters"]),
        r#"{"empty":"from-size","max_connections":"200","pg_stat_statements.track":"top","shared_buffers":"2GB","work_mem":"64MB"}"#
    );
    assert_eq!(as_json(&spec["resources"]), r#"{"limits":{"memory":"1Gi"},"requests":{"cpu":"2","memory":"8Gi"}}"#);
    assert_eq!(out.status["sizing"]["size"], "m");
}

#[test]
fn promotion_reload_marker() {
    let mut observed = running();
    observed.insert("recovery-cluster".into(), obj("
apiVersion: kubernetes.m.crossplane.io/v1alpha1
kind: Object
status: {atProvider: {manifest: {apiVersion: postgresql.cnpg.io/v1, kind: Cluster, status: {lastPromotionToken: abc}}}}"));
    let out = compose(&Input {
        xr: xr("backup: {enabled: true, destinationPath: s3://b/p, s3Credentials: {secretName: s3}}\ngeoReplication: {enabled: true}"),
        observed,
        required: required(&[(REQUIRED_PROJECT, project(&format!("spec: {{locations: {{protected: {RTM}, recovery: {AMS}}}}}")))]),
    })
    .unwrap();
    // sha256("abc")[:16]
    assert_eq!(cluster_spec(&out, "recovery-cluster")["postgresql"]["parameters"]["basis.last_promotion"], "ba7816bf8f01cfea");
    assert!(
        cluster_spec(&out, "cluster")["postgresql"]["parameters"].get("basis.last_promotion").is_none(),
        "protected site never promoted"
    );
}

#[test]
fn assets() {
    let rules = crate::valkeycache::alert_rules(ALERT_RULES_SOURCE, "payments", "orders-db", &["CNPGClusterHACritical".into()]).unwrap();
    assert_eq!(rules.len(), 20, "21 alert rules minus the excluded one");
    let text = serde_json::to_string(&rules).unwrap();
    assert!(!text.contains("zz") && text.contains(r#"namespace=\"payments\""#), "alert rules not scoped to the cluster");
    let dash: Value = serde_json::from_str(&dashboard_json("payments", "orders-db", "cnpg-x")).unwrap();
    assert_eq!(dash["uid"], "cnpg-x");
    assert_eq!(dash["title"], "CloudNativePG / payments / orders-db");
}

#[test]
fn cluster_waits_for_its_object_store() {
    let x = xr("backup: {enabled: true, destinationPath: s3://b/p, s3Credentials: {secretName: s3}}");
    let compose_with = |observed: &[(&str, Value)]| {
        compose(&Input {
            xr: x.clone(),
            observed: observed.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            required: required(&[(REQUIRED_PROJECT, protected())]),
        })
        .unwrap()
        .composed
    };

    // First round: the ObjectStore goes out, the Cluster waits for it.
    let first = compose_with(&[]);
    assert!(first.contains_key("objectstore"), "no objectstore composed");
    assert!(!first.contains_key("cluster"), "cluster composed before its ObjectStore exists in the location");

    // Once the location reports the ObjectStore, the Cluster follows.
    let store = obj("
apiVersion: kubernetes.m.crossplane.io/v1alpha1
kind: Object
status: {atProvider: {manifest: {apiVersion: barmancloud.cnpg.io/v1, kind: ObjectStore}}}");
    assert!(compose_with(&[("objectstore", store)]).contains_key("cluster"), "no cluster once the ObjectStore exists");

    // A Cluster composed before stays, also while its location reports
    // nothing (unreachable): dropping it would delete the database.
    let silent = obj("apiVersion: kubernetes.m.crossplane.io/v1alpha1\nkind: Object");
    assert!(
        compose_with(&[("cluster", silent.clone()), ("objectstore", silent)]).contains_key("cluster"),
        "an existing cluster was dropped"
    );
}

// Topology.

fn status(demotion: &str, last_promotion: &str) -> ClusterStatus {
    ClusterStatus { demotion_token: demotion.into(), last_promotion_token: last_promotion.into(), ..Default::default() }
}

/// Two members: orders-db in rtm (protected), orders-db-onprem-ams in ams (recovery).
fn two_sites(protected: ClusterStatus, recovery: ClusterStatus) -> Vec<TopologyMember> {
    vec![
        TopologyMember { location: RTM.into(), topology: "orders-db".into(), status: protected },
        TopologyMember { location: AMS.into(), topology: "orders-db-onprem-ams".into(), status: recovery },
    ]
}

fn mp(role: Role, primary: &str, source: &str, token: &str) -> MemberPlacement {
    MemberPlacement { role, primary: primary.into(), source: source.into(), promotion_token: token.into() }
}

#[test]
fn place_members() {
    use Role::*;
    let (db, ams_db) = ("orders-db", "orders-db-onprem-ams");
    struct Case {
        name: &'static str,
        members: Vec<TopologyMember>,
        target: &'static str,
        prev: &'static str,
        mode: &'static str,
        token: &'static str,
        current: &'static str,
        want_token: &'static str,
        waiting: bool,
        want: Vec<(&'static str, MemberPlacement)>,
    }
    let cases = vec![
        Case { name: "single site",
            members: vec![TopologyMember { location: RTM.into(), topology: db.into(), ..Default::default() }],
            target: RTM, prev: RTM, mode: SWITCHOVER, token: "", current: RTM, want_token: "", waiting: false,
            want: vec![(RTM, mp(Primary, db, db, ""))] },
        Case { name: "steady, replica cluster follows the primary",
            members: two_sites(status("", ""), status("", "")),
            target: RTM, prev: RTM, mode: SWITCHOVER, token: "", current: RTM, want_token: "", waiting: false,
            want: vec![(RTM, mp(Primary, db, ams_db, "")), (AMS, mp(Replica, db, db, ""))] },
        Case { name: "steady after a promotion keeps the token",
            members: two_sites(status("", ""), status("", "t1")),
            target: AMS, prev: AMS, mode: SWITCHOVER, token: "t1", current: AMS, want_token: "t1", waiting: false,
            want: vec![(RTM, mp(Replica, ams_db, ams_db, "")), (AMS, mp(Primary, ams_db, db, "t1"))] },
        Case { name: "switchover waits for the demotion token",
            members: two_sites(status("", ""), status("", "")),
            target: AMS, prev: RTM, mode: SWITCHOVER, token: "", current: RTM, want_token: "", waiting: true,
            // The old primary is demoted: it names the target. The target
            // keeps following the old primary until the token is there.
            want: vec![(RTM, mp(Primary, ams_db, ams_db, "")), (AMS, mp(Promoting, db, db, ""))] },
        Case { name: "switchover ignores a demotion token that was used before",
            members: two_sites(status("old", ""), status("", "old")),
            target: AMS, prev: RTM, mode: SWITCHOVER, token: "", current: RTM, want_token: "", waiting: true,
            want: vec![(RTM, mp(Primary, ams_db, ams_db, "")), (AMS, mp(Promoting, db, db, ""))] },
        Case { name: "switchover promotes with a fresh demotion token",
            members: two_sites(status("new", ""), status("", "old")),
            target: AMS, prev: RTM, mode: SWITCHOVER, token: "", current: AMS, want_token: "new", waiting: false,
            want: vec![(RTM, mp(Replica, ams_db, ams_db, "")), (AMS, mp(Primary, ams_db, db, "new"))] },
        Case { name: "failover promotes right away, without a token",
            members: two_sites(status("", ""), status("", "")),
            target: AMS, prev: RTM, mode: FAILOVER, token: "", current: AMS, want_token: "", waiting: false,
            want: vec![(RTM, mp(Replica, ams_db, ams_db, "")), (AMS, mp(Primary, ams_db, db, ""))] },
        Case { name: "switching back waits for the recovery site's demotion token",
            members: two_sites(status("", ""), status("", "t1")),
            target: RTM, prev: AMS, mode: SWITCHOVER, token: "t1", current: AMS, want_token: "", waiting: true,
            want: vec![(RTM, mp(Promoting, ams_db, ams_db, "")), (AMS, mp(Primary, db, db, ""))] },
    ];
    for c in cases {
        let p = place(&c.members, c.target, c.prev, c.mode, c.token);
        assert_eq!((p.current.as_str(), p.token.as_str(), p.waiting), (c.current, c.want_token, c.waiting), "{}: current/token/waiting", c.name);
        let want: BTreeMap<String, MemberPlacement> = c.want.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        assert_eq!(p.members, want, "{}: members", c.name);
    }
}

// Extensions.

/// The extensions catalog as apis/postgrescluster/extensions.yaml has it:
/// vector ships with the image, vchord and pg_search are mounted from images.
const EXTENSIONS_CATALOG: &str = "data: {extensions: [
  {name: vector},
  {name: vchord, requires: [vector], sharedPreloadLibraries: [vchord],
   image: {reference: ghcr.io/tensorchord/vchord-scratch:pg18},
   extensionControlPath: [usr/share/postgresql/18], dynamicLibraryPath: [usr/lib/postgresql/18/lib]},
  {name: pg_search, requires: [vector], sharedPreloadLibraries: [pg_search],
   image: {reference: paradedb/paradedb-extension:18-trixie}, ldLibraryPath: [system]}]}";

const SIZES_CATALOG: &str = "data: {sizes: [{name: m, resources: {requests: {cpu: 2, memory: 8Gi}},
  parameters: {maintenance_work_mem: 512MB, work_mem: 16MB},
  profiles: {vector: {parameters: {maintenance_work_mem: 2GB, max_parallel_maintenance_workers: 2}}}}]}";

fn compose_vector(spec: &str, observed: BTreeMap<String, Value>, req: Option<BTreeMap<String, Vec<Value>>>) -> Output {
    let mut req = req.unwrap_or_else(|| {
        required(&[(REQUIRED_SIZES, vec![obj(SIZES_CATALOG)]), (REQUIRED_EXTENSIONS, vec![obj(EXTENSIONS_CATALOG)])])
    });
    req.insert(REQUIRED_PROJECT.into(), protected());
    compose(&Input { xr: xr(spec), observed, required: req }).unwrap()
}

/// The custom exporter queries ConfigMap's content.
fn queries(out: &Output) -> String {
    out.composed["monitoring-queries"].object["spec"]["forProvider"]["manifest"]["data"]["queries"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn message(out: &Output) -> &str {
    out.status["message"].as_str().unwrap_or_default()
}

#[test]
fn image_extensions() {
    let out = compose_vector("
postgresVersion: 18
postgresql: {sharedPreloadLibraries: [pg_stat_statements]}
database: {extensions: [vector, vchord, pg_search]}", BTreeMap::new(), None);
    let pg = &cluster_spec(&out, "cluster")["postgresql"];
    assert_eq!(as_json(&pg["shared_preload_libraries"]), r#"["pg_stat_statements","vchord","pg_search"]"#);
    assert_eq!(
        as_json(&pg["extensions"]),
        concat!(
            r#"[{"dynamic_library_path":["usr/lib/postgresql/18/lib"],"extension_control_path":["usr/share/postgresql/18"],"#,
            r#""image":{"reference":"ghcr.io/tensorchord/vchord-scratch:pg18"},"name":"vchord"},"#,
            r#"{"image":{"reference":"paradedb/paradedb-extension:18-trixie"},"ld_library_path":["system"],"name":"pg_search"}]"#
        )
    );
    assert!(!message(&out).contains("postgresVersion"), "unexpected problem: {}", message(&out));
}

#[test]
fn image_extensions_need_postgres_18() {
    let out = compose_vector("
postgresVersion: 17
database: {extensions: [vector, vchord]}", BTreeMap::new(), None);
    let pg = &cluster_spec(&out, "cluster")["postgresql"];
    assert!(pg.get("extensions").is_none() && pg.get("shared_preload_libraries").is_none(),
        "image extension mounted into PostgreSQL 17: {}", as_json(pg));
    assert!(message(&out).contains("needs postgresVersion 18"), "status.message {:?}", message(&out));
}

// A running cluster keeps what it mounts and preloads while the catalog
// can't say how: dropping a preloaded library's image stops PostgreSQL.
#[test]
fn image_extensions_kept_without_catalog() {
    let mut observed = running();
    let manifest = obj("
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
spec:
  postgresql:
    shared_preload_libraries: [vchord, auto_explain]
    extensions: [{name: vchord, image: {reference: ghcr.io/tensorchord/vchord-scratch:pg18}}]");
    observed.insert("cluster".into(), json!({"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
        "status": {"atProvider": {"manifest": manifest}}}));
    let out = compose_vector("
postgresVersion: 18
database: {extensions: [vector, vchord]}", observed, Some(required(&[(REQUIRED_EXTENSIONS, vec![])])));
    let pg = &cluster_spec(&out, "cluster")["postgresql"];
    assert_eq!(as_json(&pg["extensions"]), r#"[{"image":{"reference":"ghcr.io/tensorchord/vchord-scratch:pg18"},"name":"vchord"}]"#);
    assert_eq!(as_json(&pg["shared_preload_libraries"]), r#"["vchord","auto_explain"]"#);
}

#[test]
fn vector_profile() {
    let out = compose_vector("
profile: vector
postgresVersion: 18
size: m
postgresql: {parameters: {work_mem: 32MB}}
database: {extensions: [vector]}", BTreeMap::new(), None);
    // The profile's settings over the size's, the spec's over both.
    assert_eq!(
        as_json(&cluster_spec(&out, "cluster")["postgresql"]["parameters"]),
        r#"{"maintenance_work_mem":"2GB","max_parallel_maintenance_workers":"2","work_mem":"32MB"}"#
    );
    assert_eq!(out.status["sizing"]["profile"], PROFILE_VECTOR);
    let q = queries(&out);
    assert!(q.contains("vector_index:") && q.contains("wal_archive:"), "vector cluster's queries: {:.200}", q);

    let general = compose_vector("size: m", BTreeMap::new(), None);
    assert_eq!(as_json(&cluster_spec(&general, "cluster")["postgresql"]["parameters"]["maintenance_work_mem"]), r#""512MB""#);
    let q = queries(&general);
    assert!(!q.is_empty() && !q.contains("vector_index"), "general cluster exports vector queries");
}

#[test]
fn vector_queries_parse() {
    let q: BTreeMap<String, Value> = serde_yaml::from_str(&queries_for(PROFILE_VECTOR)).unwrap();
    for name in ["wal_archive", "vector_index", "create_index_progress"] {
        let query = q.get(name).and_then(|v| v["query"].as_str()).unwrap_or_default();
        let metrics = q.get(name).and_then(|v| v["metrics"].as_array()).map_or(0, Vec::len);
        assert!(!query.is_empty() && metrics > 0, "query {name} missing");
    }
}

// CNPG creates a Database's extensions in order, without CASCADE: what one
// requires comes first, added if the spec leaves it out.
#[test]
fn extension_order() {
    let out = compose_vector("
postgresVersion: 18
database: {name: docs, extensions: [pg_search, pg_trgm, vchord]}", BTreeMap::new(), None);
    let exts = out.composed["database-docs"].object["spec"]["forProvider"]["manifest"]["spec"]["extensions"].as_array().unwrap().clone();
    let names: Vec<&str> = exts.iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names.join(","), "vector,pg_search,pg_trgm,vchord");
}
