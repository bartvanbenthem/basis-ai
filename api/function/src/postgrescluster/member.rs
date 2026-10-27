//! What one location runs: the CNPG Cluster, its backups, declarative
//! databases, poolers, metrics and alerts, and the Secrets it needs copied.

use k8s_openapi::api::core::v1::{ConfigMap, Secret};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use super::extensions::ClusterExtension;
use super::observed::database_applied;
use super::spec::{Backup, Store};
use super::topology::Role;
use super::{Composition, Member, PROFILE_VECTOR, dig_or, fill_params, scalar, truthy};
use crate::common::Composed;
use crate::common::kinds::crds::barman::object_store::*;
use crate::common::kinds::crds::cnpg::cluster::*;
use crate::common::kinds::crds::cnpg::database::*;
use crate::common::kinds::crds::cnpg::pooler as pl;
use crate::common::kinds::crds::cnpg::scheduled_backup::*;
use crate::common::kinds::crds::grafana::grafana_dashboard::*;
use crate::common::kinds::crds::prometheus::pod_monitor::*;
use crate::common::kinds::{Labels, enum_value, location_object, map_opt, prometheus_rule, quantities, rules, secret_copy, str_opt, to_value, vec_opt};
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
    Emitted { manifest: to_value(manifest), ready, copy_from: String::new(), backup_store: false }
}

fn map(pairs: &[(&str, &str)]) -> Labels {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
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
fn barman_store(s: &Store) -> ObjectStoreConfiguration {
    let creds = s.s3_credentials.clone().unwrap_or_default();
    let secret = creds.secret_name.clone();
    ObjectStoreConfiguration {
        destination_path: s.destination_path.clone(),
        endpoint_url: str_opt(&s.endpoint_url),
        s3_credentials: Some(ObjectStoreConfigurationS3Credentials {
            access_key_id: Some(ObjectStoreConfigurationS3CredentialsAccessKeyId {
                name: secret.clone(), key: or(&creds.access_key_id_key, "ACCESS_KEY_ID").into() }),
            secret_access_key: Some(ObjectStoreConfigurationS3CredentialsSecretAccessKey {
                name: secret.clone(), key: or(&creds.secret_access_key_key, "ACCESS_SECRET_KEY").into() }),
            region: (!creds.region_key.is_empty())
                .then(|| ObjectStoreConfigurationS3CredentialsRegion { name: secret.clone(), key: creds.region_key.clone() }),
            ..Default::default()
        }),
        endpoint_ca: s.endpoint_ca.as_ref()
            .map(|ca| ObjectStoreConfigurationEndpointCa { name: ca.secret_name.clone(), key: or(&ca.key, "ca.crt").into() }),
        ..Default::default()
    }
}

/// An image volume extension as the Cluster mounts it.
fn cluster_extension(e: &ClusterExtension) -> ClusterPostgresqlExtensions {
    ClusterPostgresqlExtensions {
        name: e.name.clone(),
        image: Some(ClusterPostgresqlExtensionsImage { reference: Some(e.image.reference.clone()), pull_policy: str_opt(&e.image.pull_policy) }),
        extension_control_path: vec_opt(e.extension_control_path.clone()),
        dynamic_library_path: vec_opt(e.dynamic_library_path.clone()),
        ld_library_path: vec_opt(e.ld_library_path.clone()),
        ..Default::default()
    }
}

/// A Barman Cloud external cluster: the backups of serverName in barmanObjectName.
fn barman_source(name: &str, object_store: &str, server: &str) -> ClusterExternalClusters {
    ClusterExternalClusters {
        name: name.into(),
        plugin: Some(ClusterExternalClustersPlugin {
            name: BARMAN_PLUGIN.into(),
            parameters: Some(map(&[("barmanObjectName", object_store), ("serverName", server)])),
            ..Default::default()
        }),
        ..Default::default()
    }
}

impl Composition<'_> {
    fn meta(&self, name: &str) -> ObjectMeta {
        crate::common::kinds::meta(name, &self.ns, &self.labels)
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

        let res = Value::Object(m.sizing.resources.clone());
        let requests = Labels::from([
            ("cpu".to_string(), scalar(&dig_or(&res, "500m".into(), &["requests", "cpu"]))),
            ("memory".to_string(), scalar(&dig_or(&res, "1Gi".into(), &["requests", "memory"]))),
        ]);
        let mut limits = Labels::from([("memory".to_string(), scalar(&dig_or(&res, "1Gi".into(), &["limits", "memory"])))]);
        if let Some(cpu) = dig(&res, &["limits", "cpu"]).filter(|v| truthy(v)) {
            limits.insert("cpu".into(), scalar(cpu));
        }
        let mut cs = ClusterSpec {
            description: Some(format!("PostgresCluster {ns}/{name} (postgres.cndev.nl)")),
            instances: m.instances,
            image_catalog_ref: Some(ClusterImageCatalogRef { api_group: Some("postgresql.cnpg.io".into()), kind: "ClusterImageCatalog".into(),
                name: or(&spec.image_catalog, "postgresql-standard-trixie").into(), major: version }),
            enable_superuser_access: Some(spec.enable_superuser_access),
            primary_update_strategy: Some(enum_value("spec.highAvailability.primaryUpdateStrategy",
                or(&ha.primary_update_strategy, "unsupervised"))?),
            primary_update_method: Some(enum_value("spec.highAvailability.primaryUpdateMethod", or(&ha.primary_update_method, "switchover"))?),
            // Copied by CNPG onto every object it generates (pods, PVCs,
            // services, secrets): lets Prometheus relabelling and the
            // Backstage Kubernetes plugin find all of them.
            inherited_metadata: Some(ClusterInheritedMetadata { labels: Some(map(&[
                ("postgres.cndev.nl/postgrescluster", name),
                ("backstage.io/kubernetes-id", name),
            ])), ..Default::default() }),
            storage: Some(ClusterStorage { size: Some(or(&spec.storage.size, "10Gi").into()), storage_class: str_opt(&spec.storage.storage_class),
                ..Default::default() }),
            wal_storage: spec.wal_storage.as_ref().map(|w| ClusterWalStorage { size: Some(w.size.clone()), storage_class: str_opt(&w.storage_class),
                ..Default::default() }),
            resources: Some(ClusterResources { requests: Some(quantities(requests)), limits: Some(quantities(limits)), ..Default::default() }),
            affinity: Some(ClusterAffinity { enable_pod_anti_affinity: Some(true),
                pod_anti_affinity_type: Some(or(&ha.pod_anti_affinity_type, "preferred").into()),
                topology_key: Some("kubernetes.io/hostname".into()), ..Default::default() }),
            ..Default::default()
        };
        if ha.zone_spread.unwrap_or(true) {
            cs.topology_spread_constraints = Some(vec![ClusterTopologySpreadConstraints {
                max_skew: 1, topology_key: "topology.kubernetes.io/zone".into(),
                // ScheduleAnyway: single-zone clusters keep working; the
                // CNPGClusterZoneSpreadWarning alert flags the imbalance.
                when_unsatisfiable: "ScheduleAnyway".into(),
                label_selector: Some(ClusterTopologySpreadConstraintsLabelSelector { match_labels: Some(map(&[
                    ("cnpg.io/cluster", name),
                    ("cnpg.io/podRole", "instance"),
                ])), ..Default::default() }),
                ..Default::default()
            }]);
        }
        let pg = &spec.postgresql;
        let images = m.image_extensions(&self.extensions);
        let preload = m.preload_libraries(&pg.shared_preload_libraries, &self.extensions, &images);
        if !params.is_empty() || !pg.pg_hba.is_empty() || !preload.is_empty() || !images.is_empty() || ha.synchronous_replicas > 0 {
            let mut p = ClusterPostgresql { parameters: map_opt(params), pg_hba: vec_opt(pg.pg_hba.clone()), shared_preload_libraries: vec_opt(preload),
                extensions: vec_opt(images.iter().map(cluster_extension).collect()), ..Default::default() };
            if ha.synchronous_replicas > 0 {
                p.synchronous = Some(ClusterPostgresqlSynchronous { method: ClusterPostgresqlSynchronousMethod::Any, number: ha.synchronous_replicas,
                    data_durability: Some(enum_value("spec.highAvailability.synchronousDataDurability",
                        or(&ha.synchronous_data_durability, "preferred"))?),
                    failover_quorum: None, max_standby_names_from_cluster: None, standby_names_post: None, standby_names_pre: None });
            }
            cs.postgresql = Some(p);
        }
        let mut bootstrap = ClusterBootstrap::default();
        if let Some(r) = &m.restore {
            // Point-in-time recovery from another cluster's backups
            // (spec.restore); the application owner's password is reset into
            // the <name>-app Secret.
            bootstrap.recovery = Some(ClusterBootstrapRecovery { source: Some(RESTORE_SOURCE.into()), database: str_opt(db.name()), owner: str_opt(db.owner()),
                recovery_target: (!r.target_time.is_empty())
                    .then(|| ClusterBootstrapRecoveryRecoveryTarget { target_time: Some(r.target_time.clone()), ..Default::default() }),
                ..Default::default() });
        } else if m.original {
            bootstrap.initdb = Some(ClusterBootstrapInitdb { database: Some(db.name().into()), owner: Some(db.owner().into()),
                encoding: Some(or(&db.encoding, "UTF8").into()), locale_collate: Some(or(&db.locale_collate, "C").into()),
                locale_c_type: Some(or(&db.locale_c_type, "C").into()), ..Default::default() });
        } else {
            // A replica cluster starts from the original member's base backup
            // and WAL archive.
            bootstrap.recovery = Some(ClusterBootstrapRecovery { source: Some(members[0].topology.clone()), ..Default::default() });
        }
        cs.bootstrap = Some(bootstrap);
        let mut external_clusters = vec![];
        if distributed {
            // Distributed topology: self/primary decide whether this member is
            // the primary or a replica cluster following source.
            let p = &m.placement;
            cs.replica = Some(ClusterReplica { r#_self: Some(m.topology.clone()), primary: Some(p.primary.clone()), source: p.source.clone(),
                promotion_token: str_opt(&p.promotion_token), ..Default::default() });
            for o in members {
                external_clusters.push(barman_source(&o.topology, &object_store_name, &o.topology));
            }
        }
        if let Some(r) = &m.restore {
            external_clusters.push(barman_source(RESTORE_SOURCE, &format!("{name}-restore"), &r.server_name));
        }
        cs.external_clusters = vec_opt(external_clusters);
        let exposed = spec.expose.as_ref().filter(|e| e.enabled);
        if !spec.roles.is_empty() || exposed.is_some() {
            let roles = spec.roles.iter().map(|r| ClusterManagedRoles { name: r.name.clone(), ensure: Some(ClusterManagedRolesEnsure::Present),
                login: Some(r.login.unwrap_or(true)), createdb: Some(r.create_db), connection_limit: Some(r.connection_limit.unwrap_or(-1)),
                in_roles: vec_opt(r.in_roles.clone()),
                password_secret: (!r.password_secret.is_empty()).then(|| ClusterManagedRolesPasswordSecret { name: r.password_secret.clone() }),
                ..Default::default() }).collect();
            let services = exposed.map(|e| ClusterManagedServices { additional: Some(vec![ClusterManagedServicesAdditional {
                selector_type: ClusterManagedServicesAdditionalSelectorType::Rw,
                service_template: ClusterManagedServicesAdditionalServiceTemplate {
                    metadata: Some(ClusterManagedServicesAdditionalServiceTemplateMetadata { name: Some(format!("{name}-external")),
                        annotations: map_opt(e.annotations.clone()), ..Default::default() }),
                    spec: Some(ClusterManagedServicesAdditionalServiceTemplateSpec { r#type: Some(or(&e.type_, "LoadBalancer").into()),
                        load_balancer_source_ranges: vec_opt(e.load_balancer_source_ranges.clone()), ..Default::default() }),
                },
                update_strategy: None,
            }]), ..Default::default() });
            cs.managed = Some(ClusterManaged { roles: vec_opt(roles), services });
        }
        if mon.enabled() {
            // Next to CNPG's default queries (the monitoring-queries ConfigMap).
            cs.monitoring = Some(ClusterMonitoring { custom_queries_config_map: Some(vec![ClusterMonitoringCustomQueriesConfigMap {
                name: format!("{name}-monitoring"), key: "queries".into() }]), ..Default::default() });
        }
        if backup.enabled {
            let mut parameters = map(&[("barmanObjectName", &object_store_name)]);
            if m.topology != name {
                // Its own folder in the shared object store (a replica
                // cluster, or a restored cluster).
                parameters.insert("serverName".into(), m.topology.clone());
            }
            cs.plugins = Some(vec![ClusterPlugins { name: BARMAN_PLUGIN.into(), is_wal_archiver: Some(true), parameters: Some(parameters),
                ..Default::default() }]);
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
            out.insert("cluster".into(), emit(&Cluster { metadata: self.meta(name), spec: cs, status: None }, m.status.ready()));
        }

        // ================= Backups: Barman Cloud ObjectStore + ScheduledBackup =================
        if backup.enabled {
            let compression = or(&backup.compression, "gzip");
            let mut configuration = barman_store(&backup.store());
            configuration.wal = Some(ObjectStoreConfigurationWal { compression: Some(enum_value("spec.backup.compression", compression)?),
                max_parallel: Some(2), ..Default::default() });
            configuration.data = Some(ObjectStoreConfigurationData { compression: Some(enum_value("spec.backup.compression", compression)?),
                jobs: Some(2), ..Default::default() });
            let mut metadata = self.meta(&object_store_name);
            // What the Project's inventory of its bucket (status.backup.servers)
            // records about this folder, and keeps after the cluster is gone.
            metadata.annotations = Some(Labels::from([
                ("postgres.cndev.nl/server-name".to_string(), m.topology.clone()),
                ("postgres.cndev.nl/postgres-version".to_string(), version.to_string()),
                ("postgres.cndev.nl/database".to_string(), db.name().to_string()),
                ("postgres.cndev.nl/database-owner".to_string(), db.owner().to_string()),
            ]));
            let os = ObjectStore { metadata, spec: ObjectStoreSpec { retention_policy: Some(or(&backup.retention_policy, "30d").into()), configuration,
                ..Default::default() }, status: None };
            let mut e = emit(&os, exists("objectstore"));
            e.backup_store = true;
            out.insert("objectstore".into(), e);

            let sb = ScheduledBackup { metadata: self.meta(&format!("{name}-scheduled")),
                spec: ScheduledBackupSpec { schedule: or(&backup.schedule, "0 0 2 * * *").into(),
                    // Take the first base backup right away: WAL archiving alone
                    // is not restorable until a base backup exists.
                    immediate: Some(true), backup_owner_reference: Some(ScheduledBackupBackupOwnerReference::r#_Self),
                    method: Some(ScheduledBackupMethod::Plugin),
                    plugin_configuration: Some(ScheduledBackupPluginConfiguration { name: BARMAN_PLUGIN.into(), parameters: None }),
                    cluster: ScheduledBackupCluster { name: name.into() }, ..Default::default() },
                status: None };
            out.insert("scheduled-backup".into(), emit(&sb, exists("scheduled-backup")));
        }

        // ================= Restore source: read-only ObjectStore =================
        if let Some(r) = &m.restore {
            // No retentionPolicy: the source's backups are only read, never
            // pruned through this store.
            let os = ObjectStore { metadata: self.meta(&format!("{name}-restore")),
                spec: ObjectStoreSpec { configuration: barman_store(&r.store), ..Default::default() }, status: None };
            out.insert("restore-objectstore".into(), emit(&os, exists("restore-objectstore")));
        }

        // ================= Declarative databases =================
        let mut database = |db_name: &str, owner: &str, reclaim: &str, extensions: &[String]| -> crate::common::Result<()> {
            let key = format!("database-{}", db_name.replace('_', "-"));
            let d = Database { metadata: self.meta(&format!("{name}-{}", db_name.replace('_', "-"))),
                spec: DatabaseSpec { cluster: DatabaseCluster { name: Some(name.into()) }, name: db_name.into(), owner: owner.into(),
                    ensure: Some(DatabaseEnsure::Present),
                    database_reclaim_policy: Some(enum_value("spec.databases[].reclaimPolicy", reclaim)?),
                    extensions: vec_opt(self.extensions.ordered(extensions).into_iter()
                        .map(|e| DatabaseExtensions { name: e, ensure: Some(DatabaseExtensionsEnsure::Present), ..Default::default() }).collect()),
                    ..Default::default() },
                status: None };
            // CNPG applies a Database only on the primary; a replica cluster
            // gets it through replication and waits until it is promoted.
            let replica = distributed && m.placement.role != Role::Primary;
            let ready = replica || database_applied(m.observed.get(&key));
            out.insert(key, emit(&d, ready));
            Ok(())
        };
        let mut listed = false;
        for d in &spec.databases {
            database(&d.name, &d.owner, or(&d.reclaim_policy, "retain"), &d.extensions)?;
            listed = listed || d.name == db.name();
        }
        // The bootstrap database's extensions, unless a databases[] entry
        // manages that database. Never dropped: retain.
        if !db.extensions.is_empty() && !listed {
            database(db.name(), db.owner(), "retain", &db.extensions)?;
        }

        // ================= PgBouncer poolers =================
        if pooler.enabled {
            let mut types = vec!["rw"];
            if pooler.read_only {
                types.push("ro");
            }
            for t in types {
                let pooler_name = format!("{name}-pooler-{t}");
                let term = pl::PoolerTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecution {
                    weight: 100,
                    pod_affinity_term: pl::PoolerTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTerm {
                        topology_key: "kubernetes.io/hostname".into(),
                        label_selector: Some(pl::PoolerTemplateSpecAffinityPodAntiAffinityPreferredDuringSchedulingIgnoredDuringExecutionPodAffinityTermLabelSelector {
                            match_labels: Some(map(&[("cnpg.io/poolerName", &pooler_name)])), ..Default::default() }),
                        ..Default::default()
                    },
                };
                let p = pl::Pooler { metadata: self.meta(&pooler_name),
                    spec: pl::PoolerSpec {
                        cluster: pl::PoolerCluster { name: name.into() },
                        instances: Some(or_i(pooler.instances, 2) as i32),
                        r#type: Some(enum_value("pooler type", t)?),
                        pgbouncer: pl::PoolerPgbouncer { pool_mode: Some(enum_value("spec.pooler.poolMode", or(&pooler.pool_mode, "transaction"))?),
                            parameters: Some(Labels::from([
                                ("max_client_conn".to_string(), or_i(pooler.max_client_conn, 1000).to_string()),
                                ("default_pool_size".to_string(), or_i(pooler.default_pool_size, 25).to_string()),
                            ])), ..Default::default() },
                        template: Some(pl::PoolerTemplate {
                            metadata: Some(pl::PoolerTemplateMetadata { labels: Some(map(&[
                                ("postgres.cndev.nl/postgrescluster", name),
                                ("backstage.io/kubernetes-id", name),
                            ])), ..Default::default() }),
                            // containers is required by the Pooler schema, even when empty.
                            spec: Some(pl::PoolerTemplateSpec { containers: vec![], affinity: Some(pl::PoolerTemplateSpecAffinity {
                                pod_anti_affinity: Some(pl::PoolerTemplateSpecAffinityPodAntiAffinity {
                                    preferred_during_scheduling_ignored_during_execution: Some(vec![term]), ..Default::default() }),
                                ..Default::default() }), ..Default::default() }),
                        }),
                        ..Default::default()
                    },
                    status: None };
                out.insert(format!("pooler-{t}"), emit(&p, exists(&format!("pooler-{t}"))));
            }
        }

        // ================= Prometheus metrics =================
        let mut mon_labels = self.labels.clone();
        for (k, v) in &mon.pod_monitor_labels {
            mon_labels.insert(k.clone(), v.clone());
        }
        let pod_monitor = |obj_name: &str, role: &str| PodMonitor {
            metadata: crate::common::kinds::meta(obj_name, ns, &mon_labels),
            spec: PodMonitorSpec {
                selector: PodMonitorSelector { match_labels: Some(map(&[("cnpg.io/cluster", name), ("cnpg.io/podRole", role)])), ..Default::default() },
                pod_metrics_endpoints: Some(vec![PodMonitorPodMetricsEndpoints { port: Some("metrics".into()), ..Default::default() }]),
                ..Default::default()
            },
            status: None,
        };
        if mon.enabled() {
            // Replaces the deprecated Cluster.spec.monitoring.enablePodMonitor:
            // scrapes the CNPG exporter (port "metrics", 9187) on every instance.
            out.insert("podmonitor".into(), emit(&pod_monitor(name, "instance"), exists("podmonitor")));
            // CNPG reloads the queries when this ConfigMap changes.
            let mut cm_labels = Labels::from([("cnpg.io/reload".to_string(), String::new())]);
            cm_labels.extend(self.labels.clone());
            let cm = ConfigMap { metadata: crate::common::kinds::meta(&format!("{name}-monitoring"), ns, &cm_labels),
                data: Some(Labels::from([("queries".to_string(), queries_for(spec.profile()))])), ..Default::default() };
            out.insert("monitoring-queries".into(), emit(&cm, exists("monitoring-queries")));
            if pooler.enabled {
                // PgBouncer exporter (port "metrics", 9127) on every pooler pod.
                out.insert("podmonitor-pooler".into(), emit(&pod_monitor(&format!("{name}-pooler"), "pooler"), exists("podmonitor-pooler")));
            }
        }
        if mon.rules() {
            let alerts = crate::valkeycache::alert_rules(ALERT_RULES_SOURCE, ns, name, &mon.prometheus_rule.exclude_rules)?;
            let pr = prometheus_rule(crate::common::kinds::meta(&format!("{name}-alerts"), ns, &mon_labels), format!("cloudnative-pg/{ns}/{name}"),
                rules(alerts)?);
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
            // Its data and type are patched in by the Object's references, never written here.
            let mut e = emit(&Secret { metadata: self.meta(&secret), ..Default::default() }, exists(&key));
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
        let mut references = vec![];
        if !e.copy_from.is_empty() {
            let parts: Vec<&str> = e.copy_from.split('/').collect();
            let (from_ns, from_name) = if parts.len() == 2 { (parts[0], parts[1]) } else { (self.ns.as_str(), e.copy_from.as_str()) };
            references = secret_copy(from_ns, from_name);
        }
        let o = location_object(crate::common::kinds::meta(&format!("{}-{key}", self.name), &self.ns, &labels), &m.location, e.manifest, references);
        Composed { object: to_value(&o), ready: e.ready }
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
            metadata: self.meta(&format!("{}-cnpg", self.name)),
            spec: GrafanaDashboardSpec {
                instance_selector: GrafanaDashboardInstanceSelector { match_labels: Some(match_labels), ..Default::default() },
                allow_cross_namespace_import: Some(g.allow_cross_namespace_import),
                folder: Some(or(&g.folder, "CloudNativePG").into()),
                // Unique per cluster (the upstream JSON hardcodes "cloudnative-pg",
                // which made every cluster's dashboard collide in one Grafana).
                uid: Some(uid.into()),
                resync_period: Some("10m".into()),
                datasources: Some(vec![GrafanaDashboardDatasources { input_name: "DS_PROMETHEUS".into(),
                    datasource_name: or(&g.datasource_name, "prometheus").into() }]),
                json: Some(dashboard_json(&self.ns, &self.name, uid)),
                ..Default::default()
            },
            status: None,
        }
    }
}
