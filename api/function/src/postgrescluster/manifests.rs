//! The objects the composition emits. Only the fields it sets, so what reaches
//! a location is exactly what the composition means: the upstream CNPG,
//! Barman Cloud and Prometheus Operator types serialise defaulted and empty
//! fields (status, syncReplicaElectionConstraint, ...) that provider-kubernetes
//! would then apply to every running cluster. A field that may be left out
//! is skipped when empty.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

use crate::lenient;

pub type Labels = BTreeMap<String, String>;

#[derive(Debug, Clone, Default, Serialize)]
pub struct Meta {
    pub name: String,
    pub namespace: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub annotations: Labels,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: Labels,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Ref {
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct KeyRef {
    pub name: String,
    pub key: String,
}

// ---- postgresql.cnpg.io/v1 Cluster

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cluster {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: ClusterSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSpec {
    pub description: String,
    pub instances: i64,
    pub image_catalog_ref: ImageCatalogRef,
    pub enable_superuser_access: bool,
    pub primary_update_strategy: String,
    pub primary_update_method: String,
    pub inherited_metadata: InheritedMetadata,
    pub storage: VolumeSpec,
    #[serde(rename = "walStorage", skip_serializing_if = "Option::is_none")]
    pub wal_storage: Option<VolumeSpec>,
    pub resources: Resources,
    pub affinity: ClusterAffinity,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub topology_spread_constraints: Vec<TopologySpreadConstraint>,
    #[serde(rename = "postgresql", skip_serializing_if = "Option::is_none")]
    pub postgresql: Option<PostgresConfig>,
    pub bootstrap: Bootstrap,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replica: Option<ReplicaTopology>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub external_clusters: Vec<ExternalCluster>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed: Option<Managed>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitoring: Option<ClusterMonitoring>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<ClusterPlugin>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCatalogRef {
    pub api_group: String,
    pub kind: String,
    pub name: String,
    pub major: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct InheritedMetadata {
    pub labels: Labels,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSpec {
    pub size: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub storage_class: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Resources {
    pub requests: Labels,
    pub limits: Labels,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterAffinity {
    pub enable_pod_anti_affinity: bool,
    pub pod_anti_affinity_type: String,
    pub topology_key: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologySpreadConstraint {
    pub max_skew: i64,
    pub topology_key: String,
    pub when_unsatisfiable: String,
    pub label_selector: LabelSelector,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelSelector {
    pub match_labels: Labels,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PostgresConfig {
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub parameters: Labels,
    #[serde(rename = "pg_hba", skip_serializing_if = "Vec::is_empty")]
    pub pg_hba: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shared_preload_libraries: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synchronous: Option<Synchronous>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extensions: Vec<ClusterExtension>,
}

lenient! {
    /// An extension mounted from an image (CNPG image volume extensions,
    /// PostgreSQL 18+). Read back from a running Cluster too.
    #[derive(Serialize)]
    pub struct ClusterExtension {
        pub name: String,
        pub image: ExtensionImage,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pub extension_control_path: Vec<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pub dynamic_library_path: Vec<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pub ld_library_path: Vec<String>,
    }
}

lenient! {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ExtensionImage {
        pub reference: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub pull_policy: String,
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Synchronous {
    pub method: String,
    pub number: i64,
    pub data_durability: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Bootstrap {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initdb: Option<InitDb>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<Recovery>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitDb {
    pub database: String,
    pub owner: String,
    pub encoding: String,
    pub locale_collate: String,
    #[serde(rename = "localeCType")]
    pub locale_c_type: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub source: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub database: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_target: Option<RecoveryTarget>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryTarget {
    pub target_time: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaTopology {
    #[serde(rename = "self")]
    pub self_: String,
    pub primary: String,
    pub source: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub promotion_token: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ExternalCluster {
    pub name: String,
    pub plugin: PluginConfig,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PluginConfig {
    pub name: String,
    pub parameters: Labels,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterPlugin {
    pub name: String,
    #[serde(rename = "isWALArchiver")]
    pub is_wal_archiver: bool,
    pub parameters: Labels,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Managed {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<ManagedRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub services: Option<ManagedServices>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRole {
    pub name: String,
    pub ensure: String,
    pub login: bool,
    #[serde(rename = "createdb")]
    pub create_db: bool,
    pub connection_limit: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub in_roles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_secret: Option<Ref>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ManagedServices {
    pub additional: Vec<ManagedService>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedService {
    pub selector_type: String,
    pub service_template: ServiceTemplate,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ServiceTemplate {
    pub metadata: ServiceTemplateMeta,
    pub spec: ServiceTemplateSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ServiceTemplateMeta {
    pub name: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub annotations: Labels,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTemplateSpec {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub load_balancer_source_ranges: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterMonitoring {
    pub custom_queries_config_map: Vec<KeyRef>,
}

// ---- barmancloud.cnpg.io/v1 ObjectStore, postgresql.cnpg.io/v1 ScheduledBackup

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStore {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: ObjectStoreSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStoreSpec {
    /// Unset on a restore source: nothing is ever pruned through it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub retention_policy: String,
    pub configuration: BarmanObjectStore,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarmanObjectStore {
    pub destination_path: String,
    #[serde(rename = "endpointURL", skip_serializing_if = "String::is_empty")]
    pub endpoint_url: String,
    #[serde(rename = "endpointCA", skip_serializing_if = "Option::is_none")]
    pub endpoint_ca: Option<KeyRef>,
    pub s3_credentials: S3Keys,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wal: Option<WalBackup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<DataBackup>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Keys {
    pub access_key_id: KeyRef,
    pub secret_access_key: KeyRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<KeyRef>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalBackup {
    pub compression: String,
    pub max_parallel: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DataBackup {
    pub compression: String,
    pub jobs: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackup {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: ScheduledBackupSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackupSpec {
    pub schedule: String,
    pub immediate: bool,
    pub backup_owner_reference: String,
    pub method: String,
    pub plugin_configuration: Ref,
    pub cluster: Ref,
}

// ---- postgresql.cnpg.io/v1 Database, Pooler

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseObject {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: DatabaseSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSpec {
    pub cluster: Ref,
    pub name: String,
    pub owner: String,
    pub ensure: String,
    pub database_reclaim_policy: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extensions: Vec<DatabaseExtension>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DatabaseExtension {
    pub name: String,
    pub ensure: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolerObject {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: PoolerSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PoolerSpec {
    pub cluster: Ref,
    pub instances: i64,
    #[serde(rename = "type")]
    pub type_: String,
    pub pgbouncer: PgBouncer,
    pub template: PoolerTemplate,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PoolerTemplate {
    pub metadata: PoolerTemplateMeta,
    pub spec: PoolerPodSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PoolerTemplateMeta {
    pub labels: Labels,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PoolerPodSpec {
    /// Required by the Pooler schema, even when empty.
    pub containers: Vec<Value>,
    pub affinity: PoolerAffinity,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolerAffinity {
    pub pod_anti_affinity: PodAntiAffinity,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PodAntiAffinity {
    #[serde(rename = "preferredDuringSchedulingIgnoredDuringExecution")]
    pub preferred: Vec<WeightedPodAffinityTerm>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeightedPodAffinityTerm {
    pub weight: i64,
    pub pod_affinity_term: PodAffinityTerm,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodAffinityTerm {
    pub topology_key: String,
    pub label_selector: LabelSelector,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PgBouncer {
    pub pool_mode: String,
    pub parameters: Labels,
}

// ---- monitoring.coreos.com/v1 PodMonitor, PrometheusRule; v1 ConfigMap, Secret

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMonitor {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: PodMonitorSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMonitorSpec {
    pub selector: LabelSelector,
    pub pod_metrics_endpoints: Vec<PortRef>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PortRef {
    pub port: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrometheusRule {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: RuleSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RuleSpec {
    pub groups: Vec<RuleGroup>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RuleGroup {
    pub name: String,
    pub rules: Vec<Value>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMap {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub data: Labels,
}

/// A copy of a Secret on the control plane: its data and type are patched
/// in by the Object's references, never written here.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
}

// ---- kubernetes.m.crossplane.io/v1alpha1 Object (provider-kubernetes)

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesObject {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: KubernetesObjectSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesObjectSpec {
    pub provider_config_ref: ProviderConfigRef,
    /// Status changes (CNPG's Cluster.status) show up without waiting for
    /// the poll interval; needs the provider's --enable-watches.
    pub watch: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<Reference>,
    pub for_provider: ForProvider,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProviderConfigRef {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ForProvider {
    pub manifest: Value,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub patches_from: PatchesFrom,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchesFrom {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub field_path: String,
}

// ---- grafana.integreatly.org/v1beta1 GrafanaDashboard

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaDashboard {
    pub api_version: String,
    pub kind: String,
    pub metadata: Meta,
    pub spec: GrafanaDashboardSpec,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaDashboardSpec {
    pub instance_selector: LabelSelector,
    pub allow_cross_namespace_import: bool,
    pub folder: String,
    /// Unique per cluster (the upstream JSON hardcodes "cloudnative-pg",
    /// which made every cluster's dashboard collide in one Grafana).
    pub uid: String,
    pub resync_period: String,
    pub datasources: Vec<DashboardDatasource>,
    pub json: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardDatasource {
    pub input_name: String,
    pub datasource_name: String,
}

