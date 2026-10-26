//! What one location runs: the CNPG Cluster, its backups, declarative
//! databases, poolers, metrics and alerts, and the Secrets it needs copied.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use super::manifests::*;
use super::observed::database_applied;
use super::spec::{Backup, Store};
use super::topology::Role;
use super::{Composition, Member, PROFILE_VECTOR, dig_or, fill_params, scalar, truthy};
use crate::common::Composed;
use crate::common::util::{dig, or, or_i, sha256hex};

const BARMAN_PLUGIN: &str = "barman-cloud.cloudnative-pg.io";
/// The name every member's Cluster gives the restore source in externalClusters.
const RESTORE_SOURCE: &str = "restore-source";

/// One object of a member, before it is wrapped in an Object.
pub(super) struct Emitted {
    manifest: Value,
    ready: bool,
    /// Copy the Secret's data and type from "<namespace>/<name>" (Secrets only).
    copy_from: String,
    /// A backup folder of this cluster: the Project keeps an inventory of them.
    backup_store: bool,
}

fn emit<T: Serialize>(manifest: &T, ready: bool) -> Emitted {
    Emitted { manifest: serde_json::to_value(manifest).expect("manifests serialise"), ready, copy_from: String::new(), backup_store: false }
}

// Vendored sources, prepared by `make generate` (tools/src/bin/generate.rs) from
// monitoring/dashboards/cnpg-cluster.json and monitoring/alerts/ with their placeholders
// for the namespace, cluster name and dashboard uid.
const DASHBOARD_SOURCE: &str = include_str!("../../assets/postgrescluster/zz_generated.dashboard.json");
pub(super) const ALERT_RULES_SOURCE: &str = include_str!("../../assets/postgrescluster/zz_generated.alert-rules.yaml");

/// Custom exporter queries (Cluster.spec.monitoring.customQueriesConfigMap).
/// wal_archive: the WAL the primary has written but not yet archived to the
/// object store, i.e. what a loss of this site loses (the RPO of a failover to
/// the recovery site, which replays WAL from the store). pending_bytes runs
/// from the start of the oldest segment still marked .ready (else the current
/// segment) to the current insert position; oldest_ready_seconds is how long
/// the oldest .ready file (segment or timeline history) has waited, 0 when
/// archiving keeps up. Standbys and replica clusters return no row.
const MONITORING_QUERIES: &str = include_str!("../../assets/postgrescluster/monitoring-queries.yaml");

/// Exporter queries of the vector profile. vector_index: size of every vector
/// (pgvector hnsw/ivfflat, VectorChord vchordrq/vchordg) and BM25 (pg_search)
/// index in every database, to compare with the memory they should fit in.
/// create_index_progress: how far index builds are, which take long for vector
/// indexes (pg_stat_progress_create_index, primary only).
const VECTOR_QUERIES: &str = include_str!("../../assets/postgrescluster/vector-queries.yaml");

/// The custom exporter queries of a cluster with this profile.
pub(super) fn queries_for(profile: &str) -> String {
    let mut q = MONITORING_QUERIES.strip_suffix('\n').unwrap_or(MONITORING_QUERIES).to_string();
    if profile == PROFILE_VECTOR {
        q.push('\n');
        q.push_str(VECTOR_QUERIES.strip_suffix('\n').unwrap_or(VECTOR_QUERIES));
    }
    q
}

/// CloudNativePG's official Grafana dashboard (Apache-2.0) for a cluster.
pub(super) fn dashboard_json(namespace: &str, name: &str, uid: &str) -> String {
    crate::valkeycache::substitute(DASHBOARD_SOURCE, namespace, name, uid)
}

/// The Barman Cloud configuration of a store.
fn barman_store(s: &Store) -> BarmanObjectStore {
    let creds = s.s3_credentials.clone().unwrap_or_default();
    let mut b = BarmanObjectStore {
        destination_path: s.destination_path.clone(),
        endpoint_url: s.endpoint_url.clone(),
        s3_credentials: S3Keys {
            access_key_id: KeyRef { name: creds.secret_name.clone(), key: or(&creds.access_key_id_key, "ACCESS_KEY_ID").into() },
            secret_access_key: KeyRef { name: creds.secret_name.clone(), key: or(&creds.secret_access_key_key, "ACCESS_SECRET_KEY").into() },
            region: None,
        },
        ..Default::default()
    };
    if !creds.region_key.is_empty() {
        b.s3_credentials.region = Some(KeyRef { name: creds.secret_name.clone(), key: creds.region_key.clone() });
    }
    if let Some(ca) = &s.endpoint_ca {
        b.endpoint_ca = Some(KeyRef { name: ca.secret_name.clone(), key: or(&ca.key, "ca.crt").into() });
    }
    b
}

impl Composition<'_> {
    fn meta(&self, name: &str) -> Meta {
        Meta { name: name.into(), namespace: self.ns.clone(), labels: self.labels.clone(), ..Default::default() }
    }

    /// Everything one location runs, by composition resource name (without
    /// the member's prefix).
    pub(super) fn member(&self, m: &Member, members: &[Member], distributed: bool) -> crate::common::Result<BTreeMap<String, Emitted>> {
        let spec = &self.spec;
        let (name, ns) = (self.name.as_str(), self.ns.as_str());
        let mut out: BTreeMap<String, Emitted> = BTreeMap::new();
        let exists = |key: &str| m.observed.contains_key(key);

        let backup: Backup = m.backup.clone().unwrap_or_else(|| spec.backup.clone());
        let db = &spec.database;
        let ha = &spec.high_availability;
        let pooler = &spec.pooler;
        let mon = &spec.monitoring;
        let object_store_name = format!("{name}-backup");
        let version = spec.postgres_version();

        // ================= CloudNativePG Cluster =================
        // The size's tuned settings, under the ones spec.postgresql sets; what
        // the extensions in use need (postgres-extensions catalog) under both.
        let mut params: BTreeMap<String, String> = BTreeMap::new();
        fill_params(&mut params, &spec.postgresql.parameters);
        fill_params(&mut params, &m.sizing.parameters);
        for (k, v) in &self.extensions.parameters {
            if params.get(k).is_none_or(|x| x.is_empty()) {
                params.insert(k.clone(), v.clone());
            }
        }
        // Works around a CNPG instance-manager bug (v1.30.1): on a token
        // promotion the new postgresql.conf is written while the token is not
        // yet verified, that pass returns early and the reload is lost. The new
        // primary keeps its replica-cluster config hash, the operator waits for
        // uniform hashes and never rolls the pending restarts out. Changing a
        // placeholder GUC once lastPromotionToken is recorded makes every
        // instance rewrite and reload its config, unblocking the rollout.
        let t = &m.status.last_promotion_token;
        if distributed && !t.is_empty() {
            params.insert("basis.last_promotion".into(), sha256hex(t)[..16].to_string());
        }

        let mut cs = ClusterSpec {
            description: format!("PostgresCluster {ns}/{name} (postgres.cndev.nl)"),
            instances: m.instances,
            image_catalog_ref: ImageCatalogRef { api_group: "postgresql.cnpg.io".into(), kind: "ClusterImageCatalog".into(),
                name: or(&spec.image_catalog, "postgresql-standard-trixie").into(), major: version },
            enable_superuser_access: spec.enable_superuser_access,
            primary_update_strategy: or(&ha.primary_update_strategy, "unsupervised").into(),
            primary_update_method: or(&ha.primary_update_method, "switchover").into(),
            // Copied by CNPG onto every object it generates (pods, PVCs,
            // services, secrets): lets Prometheus relabelling and the
            // Backstage Kubernetes plugin find all of them.
            inherited_metadata: InheritedMetadata { labels: Labels::from([
                ("postgres.cndev.nl/postgrescluster".to_string(), name.to_string()),
                ("backstage.io/kubernetes-id".to_string(), name.to_string()),
            ])},
            storage: VolumeSpec { size: or(&spec.storage.size, "10Gi").into(), storage_class: spec.storage.storage_class.clone() },
            affinity: ClusterAffinity { enable_pod_anti_affinity: true,
                pod_anti_affinity_type: or(&ha.pod_anti_affinity_type, "preferred").into(), topology_key: "kubernetes.io/hostname".into() },
            ..Default::default()
        };
        if let Some(w) = &spec.wal_storage {
            cs.wal_storage = Some(VolumeSpec { size: w.size.clone(), storage_class: w.storage_class.clone() });
        }
        let res = Value::Object(m.sizing.resources.clone());
        cs.resources = Resources {
            requests: Labels::from([
                ("cpu".to_string(), scalar(&dig_or(&res, "500m".into(), &["requests", "cpu"]))),
                ("memory".to_string(), scalar(&dig_or(&res, "1Gi".into(), &["requests", "memory"]))),
            ]),
            limits: Labels::from([("memory".to_string(), scalar(&dig_or(&res, "1Gi".into(), &["limits", "memory"])))]),
        };
        if let Some(cpu) = dig(&res, &["limits", "cpu"]).filter(|v| truthy(v)) {
            cs.resources.limits.insert("cpu".into(), scalar(cpu));
        }
        if ha.zone_spread.unwrap_or(true) {
            cs.topology_spread_constraints = vec![TopologySpreadConstraint {
                max_skew: 1, topology_key: "topology.kubernetes.io/zone".into(),
                // ScheduleAnyway: single-zone clusters keep working; the
                // CNPGClusterZoneSpreadWarning alert flags the imbalance.
                when_unsatisfiable: "ScheduleAnyway".into(),
                label_selector: LabelSelector { match_labels: Labels::from([
                    ("cnpg.io/cluster".to_string(), name.to_string()),
                    ("cnpg.io/podRole".to_string(), "instance".to_string()),
                ])},
            }];
        }
        let pg = &spec.postgresql;
        let images = m.image_extensions(&self.extensions);
        let preload = m.preload_libraries(&pg.shared_preload_libraries, &self.extensions, &images);
        if !params.is_empty() || !pg.pg_hba.is_empty() || !preload.is_empty() || !images.is_empty() || ha.synchronous_replicas > 0 {
            let mut p = PostgresConfig { parameters: params, pg_hba: pg.pg_hba.clone(), shared_preload_libraries: preload, extensions: images, synchronous: None };
            if ha.synchronous_replicas > 0 {
                p.synchronous = Some(Synchronous { method: "any".into(), number: ha.synchronous_replicas,
                    data_durability: or(&ha.synchronous_data_durability, "preferred").into() });
            }
            cs.postgresql = Some(p);
        }
        if let Some(r) = &m.restore {
            // Point-in-time recovery from another cluster's backups
            // (spec.restore); the application owner's password is reset into
            // the <name>-app Secret.
            let mut rec = Recovery { source: RESTORE_SOURCE.into(), database: db.name().into(), owner: db.owner().into(), recovery_target: None };
            if !r.target_time.is_empty() {
                rec.recovery_target = Some(RecoveryTarget { target_time: r.target_time.clone() });
            }
            cs.bootstrap.recovery = Some(rec);
        } else if m.original {
            cs.bootstrap.initdb = Some(InitDb { database: db.name().into(), owner: db.owner().into(), encoding: or(&db.encoding, "UTF8").into(),
                locale_collate: or(&db.locale_collate, "C").into(), locale_c_type: or(&db.locale_c_type, "C").into() });
        } else {
            // A replica cluster starts from the original member's base backup
            // and WAL archive.
            cs.bootstrap.recovery = Some(Recovery { source: members[0].topology.clone(), ..Default::default() });
        }
        if distributed {
            // Distributed topology: self/primary decide whether this member is
            // the primary or a replica cluster following source.
            let p = &m.placement;
            cs.replica = Some(ReplicaTopology { self_: m.topology.clone(), primary: p.primary.clone(), source: p.source.clone(),
                promotion_token: p.promotion_token.clone() });
            for o in members {
                cs.external_clusters.push(ExternalCluster { name: o.topology.clone(), plugin: PluginConfig {
                    name: BARMAN_PLUGIN.into(), parameters: Labels::from([
                        ("barmanObjectName".to_string(), object_store_name.clone()),
                        ("serverName".to_string(), o.topology.clone()),
                    ])}});
            }
        }
        if let Some(r) = &m.restore {
            cs.external_clusters.push(ExternalCluster { name: RESTORE_SOURCE.into(), plugin: PluginConfig {
                name: BARMAN_PLUGIN.into(), parameters: Labels::from([
                    ("barmanObjectName".to_string(), format!("{name}-restore")),
                    ("serverName".to_string(), r.server_name.clone()),
                ])}});
        }
        let exposed = spec.expose.as_ref().filter(|e| e.enabled);
        if !spec.roles.is_empty() || exposed.is_some() {
            let mut managed = Managed::default();
            for r in &spec.roles {
                let mut role = ManagedRole { name: r.name.clone(), ensure: "present".into(), login: r.login.unwrap_or(true),
                    create_db: r.create_db, connection_limit: r.connection_limit.unwrap_or(-1), in_roles: r.in_roles.clone(), password_secret: None };
                if !r.password_secret.is_empty() {
                    role.password_secret = Some(Ref { name: r.password_secret.clone() });
                }
                managed.roles.push(role);
            }
            if let Some(e) = exposed {
                let svc = ManagedService { selector_type: "rw".into(), service_template: ServiceTemplate {
                    metadata: ServiceTemplateMeta { name: format!("{name}-external"), annotations: e.annotations.clone() },
                    spec: ServiceTemplateSpec { type_: or(&e.type_, "LoadBalancer").into(), load_balancer_source_ranges: e.load_balancer_source_ranges.clone() },
                }};
                managed.services = Some(ManagedServices { additional: vec![svc] });
            }
            cs.managed = Some(managed);
        }
        if mon.enabled() {
            // Next to CNPG's default queries (the monitoring-queries ConfigMap).
            cs.monitoring = Some(ClusterMonitoring { custom_queries_config_map: vec![KeyRef { name: format!("{name}-monitoring"), key: "queries".into() }] });
        }
        if backup.enabled {
            let mut p = ClusterPlugin { name: BARMAN_PLUGIN.into(), is_wal_archiver: true,
                parameters: Labels::from([("barmanObjectName".to_string(), object_store_name.clone())]) };
            if m.topology != name {
                // Its own folder in the shared object store (a replica
                // cluster, or a restored cluster).
                p.parameters.insert("serverName".into(), m.topology.clone());
            }
            cs.plugins = vec![p];
        }
        // A new Cluster waits for the ObjectStores its plugin reads: the Barman
        // Cloud plugin's pre-reconcile hook stops the Cluster's reconcile when it
        // finds none, and nothing wakes it again, so a Cluster created in the same
        // apply as its ObjectStore can stay unbootstrapped for good. One that was
        // composed before is always kept: its Object on the control plane counts,
        // not what the location reports (which is gone while it's unreachable),
        // or the Cluster would be deleted.
        let stores_ready = (!backup.enabled || exists("objectstore")) && (m.restore.is_none() || exists("restore-objectstore"));
        if stores_ready || self.observed.contains_key(&format!("{}cluster", m.prefix)) {
            out.insert("cluster".into(), emit(&Cluster { api_version: "postgresql.cnpg.io/v1".into(), kind: "Cluster".into(),
                metadata: self.meta(name), spec: cs }, m.status.ready()));
        }

        // ================= Backups: Barman Cloud ObjectStore + ScheduledBackup =================
        if backup.enabled {
            let mut os = ObjectStore { api_version: "barmancloud.cnpg.io/v1".into(), kind: "ObjectStore".into(), metadata: self.meta(&object_store_name),
                spec: ObjectStoreSpec { retention_policy: or(&backup.retention_policy, "30d").into(), configuration: barman_store(&backup.store()) } };
            let compression = or(&backup.compression, "gzip").to_string();
            os.spec.configuration.wal = Some(WalBackup { compression: compression.clone(), max_parallel: 2 });
            os.spec.configuration.data = Some(DataBackup { compression, jobs: 2 });
            // What the Project's inventory of its bucket (status.backup.servers)
            // records about this folder, and keeps after the cluster is gone.
            os.metadata.annotations = Labels::from([
                ("postgres.cndev.nl/server-name".to_string(), m.topology.clone()),
                ("postgres.cndev.nl/postgres-version".to_string(), version.to_string()),
                ("postgres.cndev.nl/database".to_string(), db.name().to_string()),
                ("postgres.cndev.nl/database-owner".to_string(), db.owner().to_string()),
            ]);
            let mut e = emit(&os, exists("objectstore"));
            e.backup_store = true;
            out.insert("objectstore".into(), e);

            let sb = ScheduledBackup { api_version: "postgresql.cnpg.io/v1".into(), kind: "ScheduledBackup".into(),
                metadata: self.meta(&format!("{name}-scheduled")),
                spec: ScheduledBackupSpec { schedule: or(&backup.schedule, "0 0 2 * * *").into(),
                    // Take the first base backup right away: WAL archiving alone
                    // is not restorable until a base backup exists.
                    immediate: true, backup_owner_reference: "self".into(), method: "plugin".into(),
                    plugin_configuration: Ref { name: BARMAN_PLUGIN.into() }, cluster: Ref { name: name.into() } } };
            out.insert("scheduled-backup".into(), emit(&sb, exists("scheduled-backup")));
        }

        // ================= Restore source: read-only ObjectStore =================
        if let Some(r) = &m.restore {
            // No retentionPolicy: the source's backups are only read, never
            // pruned through this store.
            out.insert("restore-objectstore".into(), emit(&ObjectStore { api_version: "barmancloud.cnpg.io/v1".into(), kind: "ObjectStore".into(),
                metadata: self.meta(&format!("{name}-restore")),
                spec: ObjectStoreSpec { retention_policy: String::new(), configuration: barman_store(&r.store) } }, exists("restore-objectstore")));
        }

        // ================= Declarative databases =================
        let mut database = |db_name: &str, owner: &str, reclaim: &str, extensions: &[String]| {
            let key = format!("database-{}", db_name.replace('_', "-"));
            let d = DatabaseObject { api_version: "postgresql.cnpg.io/v1".into(), kind: "Database".into(),
                metadata: self.meta(&format!("{name}-{}", db_name.replace('_', "-"))),
                spec: DatabaseSpec { cluster: Ref { name: name.into() }, name: db_name.into(), owner: owner.into(), ensure: "present".into(),
                    database_reclaim_policy: reclaim.into(),
                    extensions: self.extensions.ordered(extensions).into_iter().map(|e| DatabaseExtension { name: e, ensure: "present".into() }).collect() } };
            // CNPG applies a Database only on the primary; a replica cluster
            // gets it through replication and waits until it is promoted.
            let replica = distributed && m.placement.role != Role::Primary;
            let ready = replica || database_applied(m.observed.get(&key));
            out.insert(key, emit(&d, ready));
        };
        let mut listed = false;
        for d in &spec.databases {
            database(&d.name, &d.owner, or(&d.reclaim_policy, "retain"), &d.extensions);
            listed = listed || d.name == db.name();
        }
        // The bootstrap database's extensions, unless a databases[] entry
        // manages that database. Never dropped: retain.
        if !db.extensions.is_empty() && !listed {
            database(db.name(), db.owner(), "retain", &db.extensions);
        }

        // ================= PgBouncer poolers =================
        if pooler.enabled {
            let mut types = vec!["rw"];
            if pooler.read_only {
                types.push("ro");
            }
            for t in types {
                let pooler_name = format!("{name}-pooler-{t}");
                let p = PoolerObject { api_version: "postgresql.cnpg.io/v1".into(), kind: "Pooler".into(), metadata: self.meta(&pooler_name),
                    spec: PoolerSpec {
                        cluster: Ref { name: name.into() },
                        instances: or_i(pooler.instances, 2),
                        type_: t.into(),
                        pgbouncer: PgBouncer { pool_mode: or(&pooler.pool_mode, "transaction").into(), parameters: Labels::from([
                            ("max_client_conn".to_string(), or_i(pooler.max_client_conn, 1000).to_string()),
                            ("default_pool_size".to_string(), or_i(pooler.default_pool_size, 25).to_string()),
                        ])},
                        template: PoolerTemplate {
                            metadata: PoolerTemplateMeta { labels: Labels::from([
                                ("postgres.cndev.nl/postgrescluster".to_string(), name.to_string()),
                                ("backstage.io/kubernetes-id".to_string(), name.to_string()),
                            ])},
                            spec: PoolerPodSpec { containers: vec![], affinity: PoolerAffinity { pod_anti_affinity: PodAntiAffinity {
                                preferred: vec![WeightedPodAffinityTerm { weight: 100, pod_affinity_term: PodAffinityTerm {
                                    topology_key: "kubernetes.io/hostname".into(),
                                    label_selector: LabelSelector { match_labels: Labels::from([("cnpg.io/poolerName".to_string(), pooler_name.clone())]) },
                                }}],
                            }}},
                        },
                    } };
                out.insert(format!("pooler-{t}"), emit(&p, exists(&format!("pooler-{t}"))));
            }
        }

        // ================= Prometheus metrics =================
        let mut mon_labels = self.labels.clone();
        for (k, v) in &mon.pod_monitor_labels {
            mon_labels.insert(k.clone(), v.clone());
        }
        let pod_monitor = |obj_name: &str, role: &str| PodMonitor {
            api_version: "monitoring.coreos.com/v1".into(), kind: "PodMonitor".into(),
            metadata: Meta { name: obj_name.into(), namespace: ns.into(), labels: mon_labels.clone(), ..Default::default() },
            spec: PodMonitorSpec {
                selector: LabelSelector { match_labels: Labels::from([
                    ("cnpg.io/cluster".to_string(), name.to_string()),
                    ("cnpg.io/podRole".to_string(), role.to_string()),
                ])},
                pod_metrics_endpoints: vec![PortRef { port: "metrics".into() }],
            },
        };
        if mon.enabled() {
            // Replaces the deprecated Cluster.spec.monitoring.enablePodMonitor:
            // scrapes the CNPG exporter (port "metrics", 9187) on every instance.
            out.insert("podmonitor".into(), emit(&pod_monitor(name, "instance"), exists("podmonitor")));
            // CNPG reloads the queries when this ConfigMap changes.
            let mut cm_labels = Labels::from([("cnpg.io/reload".to_string(), String::new())]);
            cm_labels.extend(self.labels.clone());
            out.insert("monitoring-queries".into(), emit(&ConfigMap { api_version: "v1".into(), kind: "ConfigMap".into(),
                metadata: Meta { name: format!("{name}-monitoring"), namespace: ns.into(), labels: cm_labels, ..Default::default() },
                data: Labels::from([("queries".to_string(), queries_for(spec.profile()))]) }, exists("monitoring-queries")));
            if pooler.enabled {
                // PgBouncer exporter (port "metrics", 9127) on every pooler pod.
                out.insert("podmonitor-pooler".into(), emit(&pod_monitor(&format!("{name}-pooler"), "pooler"), exists("podmonitor-pooler")));
            }
        }
        if mon.rules() {
            let rules = crate::valkeycache::alert_rules(ALERT_RULES_SOURCE, ns, name, &mon.prometheus_rule.exclude_rules)?;
            let pr = PrometheusRule { api_version: "monitoring.coreos.com/v1".into(), kind: "PrometheusRule".into(),
                metadata: Meta { name: format!("{name}-alerts"), namespace: ns.into(), labels: mon_labels.clone(), ..Default::default() },
                spec: RuleSpec { groups: vec![RuleGroup { name: format!("cloudnative-pg/{ns}/{name}"), rules }] } };
            out.insert("prometheusrule".into(), emit(&pr, exists("prometheusrule")));
        }

        // ================= Secrets a remote location needs =================
        // The S3 credentials, endpoint CA and role passwords live in the XR's
        // namespace on the control plane. Their copies are Objects that patch
        // data/type from that Secret (provider-kubernetes references), so the
        // values never appear in the Object spec.
        let mut copies: BTreeSet<String> = BTreeSet::new();
        if backup.enabled {
            if let Some(s) = &backup.s3_credentials {
                copies.insert(s.secret_name.clone());
            }
            if let Some(s) = &backup.endpoint_ca {
                copies.insert(s.secret_name.clone());
            }
        }
        if let Some(r) = &m.restore {
            if let Some(s) = &r.store.s3_credentials {
                copies.insert(s.secret_name.clone());
            }
            if let Some(s) = &r.store.endpoint_ca {
                copies.insert(s.secret_name.clone());
            }
        }
        for r in &spec.roles {
            if !r.password_secret.is_empty() {
                copies.insert(r.password_secret.clone());
            }
        }
        for secret in copies {
            let key = format!("secret-{secret}");
            let mut e = emit(&Secret { api_version: "v1".into(), kind: "Secret".into(), metadata: self.meta(&secret) }, exists(&key));
            e.copy_from = m.copy_from.get(&secret).cloned().unwrap_or_else(|| secret.clone());
            out.insert(key, e);
        }
        Ok(out)
    }

    /// Puts a member's object (composition resource name key) into a
    /// provider-kubernetes Object for the member's location.
    pub(super) fn wrap(&self, m: &Member, key: &str, e: Emitted) -> Composed {
        let mut labels = self.labels.clone();
        if e.backup_store {
            // The Project finds the backup folders in its bucket through this label.
            labels.insert("postgres.cndev.nl/backup-store".into(), "true".into());
        }
        let mut o = KubernetesObject {
            api_version: "kubernetes.m.crossplane.io/v1alpha1".into(), kind: "Object".into(),
            metadata: Meta { name: format!("{}-{key}", self.name), namespace: self.ns.clone(), labels,
                annotations: Labels::from([("platform.cndev.nl/location".to_string(), m.location.clone())]) },
            spec: KubernetesObjectSpec {
                provider_config_ref: ProviderConfigRef { kind: "ClusterProviderConfig".into(), name: m.location.clone() },
                watch: true,
                references: vec![],
                for_provider: ForProvider { manifest: e.manifest },
            },
        };
        if !e.copy_from.is_empty() {
            let parts: Vec<&str> = e.copy_from.split('/').collect();
            let (from_ns, from_name) = if parts.len() == 2 { (parts[0], parts[1]) } else { (self.ns.as_str(), e.copy_from.as_str()) };
            for field in ["data", "type"] {
                o.spec.references.push(Reference { patches_from: PatchesFrom { api_version: "v1".into(), kind: "Secret".into(),
                    name: from_name.into(), namespace: from_ns.into(), field_path: field.into() } });
            }
        }
        Composed { object: serde_json::to_value(o).expect("manifests serialise"), ready: e.ready }
    }

    /// CloudNativePG's official Grafana dashboard (Apache-2.0) for this
    /// cluster: its own title and uid, the namespace/cluster variables preset.
    pub(super) fn dashboard(&self, uid: &str) -> GrafanaDashboard {
        let g = &self.spec.monitoring.grafana_dashboard;
        let match_labels = if g.instance_selector.is_empty() {
            Labels::from([("dashboards.paas.cndev.nl/scope".to_string(), self.ns.clone())])
        } else {
            g.instance_selector.clone()
        };
        GrafanaDashboard {
            api_version: "grafana.integreatly.org/v1beta1".into(), kind: "GrafanaDashboard".into(),
            metadata: self.meta(&format!("{}-cnpg", self.name)),
            spec: GrafanaDashboardSpec {
                instance_selector: LabelSelector { match_labels },
                allow_cross_namespace_import: g.allow_cross_namespace_import,
                folder: or(&g.folder, "CloudNativePG").into(),
                uid: uid.into(),
                resync_period: "10m".into(),
                datasources: vec![DashboardDatasource { input_name: "DS_PROMETHEUS".into(), datasource_name: or(&g.datasource_name, "prometheus").into() }],
                json: dashboard_json(&self.ns, &self.name, uid),
            },
        }
    }
}
