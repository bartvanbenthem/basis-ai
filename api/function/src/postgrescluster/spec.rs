//! The PostgresCluster XR, as far as the composition reads it. Fields mirror
//! apis/postgrescluster/definition.yaml. The API server applies the XRD
//! defaults; the accessors below apply them again so `crossplane render` and
//! objects created before a default existed come out the same.

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

use crate::common::util::{or, or_i};
use crate::lenient;

lenient! {
    pub struct Metadata { pub name: String, pub namespace: String, pub uid: String }
}
lenient! {
    /// The observed PostgresCluster.
    pub struct Xr { pub metadata: Metadata, pub spec: Spec, pub status: XrStatus }
}
lenient! {
    /// The part of the XR's own status the composition carries between
    /// reconciles (pinned on first use).
    #[serde(rename_all = "camelCase")]
    pub struct XrStatus {
        pub sites: Sites,
        pub primary_location: String,
        pub promotion_token: String,
        pub backup_store: Option<BackupStore>,
        pub sizing: Option<Sizing>,
    }
}
lenient! {
    #[derive(Serialize)]
    pub struct Sites {
        pub protected: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub recovery: String,
    }
}
lenient! {
    /// The Project's bucket a cluster archives to.
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BackupStore {
        pub destination_path: String,
        #[serde(rename = "endpointURL")]
        pub endpoint_url: String,
        /// Where the Project's backup-s3-<location> Secrets are.
        pub namespace: String,
        /// The credentials carry a REGION key.
        pub region: bool,
    }
}
lenient! {
    /// What the instances run with.
    #[derive(Serialize)]
    pub struct Sizing {
        pub size: String,
        /// Profile whose settings for the size are in parameters.
        #[serde(skip_serializing_if = "String::is_empty")]
        pub profile: String,
        pub resources: Map<String, Value>,
        pub parameters: Map<String, Value>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Spec {
        pub restore: Option<Restore>,
        pub geo_replication: GeoReplication,
        pub postgres_version: i64,
        pub image_catalog: String,
        pub profile: String,
        pub instances: i64,
        pub storage: Storage,
        #[serde(rename = "walStorage")]
        pub wal_storage: Option<Storage>,
        pub size: String,
        pub resources: Map<String, Value>,
        #[serde(rename = "postgresql")]
        pub postgresql: PostgreSql,
        pub database: Database,
        pub databases: Vec<ExtraDatabase>,
        pub roles: Vec<DatabaseRole>,
        pub enable_superuser_access: bool,
        pub high_availability: HighAvailability,
        pub pooler: Pooler,
        pub backup: Backup,
        pub monitoring: Monitoring,
        pub expose: Option<Expose>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Restore { pub source: RestoreSource, pub target_time: String }
}
lenient! {
    /// spec.restore.source: a backup folder, and the store it's in.
    #[serde(rename_all = "camelCase")]
    pub struct RestoreSource {
        pub server_name: String,
        pub destination_path: String,
        #[serde(rename = "endpointURL")]
        pub endpoint_url: String,
        #[serde(rename = "endpointCA")]
        pub endpoint_ca: Option<SecretKey>,
        pub s3_credentials: Option<S3Credentials>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct SecretKey { pub secret_name: String, pub key: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct S3Credentials {
        pub secret_name: String,
        #[serde(rename = "accessKeyIdKey")]
        pub access_key_id_key: String,
        pub secret_access_key_key: String,
        pub region_key: String,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct GeoReplication { pub enabled: bool, pub instances: i64, pub primary_site: String, pub promotion: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Storage { pub size: String, pub storage_class: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct PostgreSql {
        pub parameters: Map<String, Value>,
        #[serde(rename = "pgHba")]
        pub pg_hba: Vec<String>,
        pub shared_preload_libraries: Vec<String>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Database {
        pub name: String,
        pub owner: String,
        pub encoding: String,
        pub locale_collate: String,
        #[serde(rename = "localeCType")]
        pub locale_c_type: String,
        pub extensions: Vec<String>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct ExtraDatabase { pub name: String, pub owner: String, pub extensions: Vec<String>, pub reclaim_policy: String }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct DatabaseRole {
        pub name: String,
        pub login: Option<bool>,
        #[serde(rename = "createdb")]
        pub create_db: bool,
        pub in_roles: Vec<String>,
        pub password_secret: String,
        pub connection_limit: Option<i64>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct HighAvailability {
        pub pod_anti_affinity_type: String,
        pub zone_spread: Option<bool>,
        pub synchronous_replicas: i64,
        pub synchronous_data_durability: String,
        pub primary_update_method: String,
        pub primary_update_strategy: String,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Pooler {
        pub enabled: bool,
        pub instances: i64,
        pub pool_mode: String,
        pub max_client_conn: i64,
        pub default_pool_size: i64,
        pub read_only: bool,
    }
}
lenient! {
    /// spec.backup: the settings, and the store unless it's the Project's bucket.
    #[serde(rename_all = "camelCase")]
    pub struct Backup {
        pub enabled: bool,
        pub retention_policy: String,
        pub schedule: String,
        pub compression: String,
        pub destination_path: String,
        #[serde(rename = "endpointURL")]
        pub endpoint_url: String,
        #[serde(rename = "endpointCA")]
        pub endpoint_ca: Option<SecretKey>,
        pub s3_credentials: Option<S3Credentials>,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct PrometheusRuleSpec { pub enabled: Option<bool>, pub exclude_rules: Vec<String> }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct GrafanaDashboardSpec {
        pub enabled: Option<bool>,
        pub instance_selector: BTreeMap<String, String>,
        pub allow_cross_namespace_import: bool,
        pub folder: String,
        pub datasource_name: String,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Monitoring {
        pub enabled: Option<bool>,
        pub pod_monitor_labels: BTreeMap<String, String>,
        pub prometheus_rule: PrometheusRuleSpec,
        pub grafana_dashboard: GrafanaDashboardSpec,
    }
}
lenient! {
    #[serde(rename_all = "camelCase")]
    pub struct Expose {
        pub enabled: bool,
        #[serde(rename = "type")]
        pub type_: String,
        pub annotations: BTreeMap<String, String>,
        pub load_balancer_source_ranges: Vec<String>,
    }
}

/// An S3 prefix and how to reach it: spec.backup, restore.source, or the
/// Project's bucket.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Store {
    pub destination_path: String,
    pub endpoint_url: String,
    pub endpoint_ca: Option<SecretKey>,
    pub s3_credentials: Option<S3Credentials>,
}

impl Backup {
    pub fn store(&self) -> Store {
        Store {
            destination_path: self.destination_path.clone(),
            endpoint_url: self.endpoint_url.clone(),
            endpoint_ca: self.endpoint_ca.clone(),
            s3_credentials: self.s3_credentials.clone(),
        }
    }
}

impl RestoreSource {
    pub fn store(&self) -> Store {
        Store {
            destination_path: self.destination_path.clone(),
            endpoint_url: self.endpoint_url.clone(),
            endpoint_ca: self.endpoint_ca.clone(),
            s3_credentials: self.s3_credentials.clone(),
        }
    }
}

// Workload profiles (spec.profile).
pub const PROFILE_GENERAL: &str = "general";
pub const PROFILE_VECTOR: &str = "vector";

impl Spec {
    pub fn postgres_version(&self) -> i64 {
        or_i(self.postgres_version, 17)
    }
    pub fn instances(&self) -> i64 {
        or_i(self.instances, 3)
    }
    pub fn profile(&self) -> &str {
        or(&self.profile, PROFILE_GENERAL)
    }
}

impl Database {
    pub fn name(&self) -> &str {
        or(&self.name, "app")
    }
    pub fn owner(&self) -> &str {
        or(&self.owner, "app")
    }
}

impl Monitoring {
    pub fn enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
    pub fn rules(&self) -> bool {
        self.enabled() && self.prometheus_rule.enabled.unwrap_or(true)
    }
    pub fn dashboard(&self) -> bool {
        self.grafana_dashboard.enabled.unwrap_or(true)
    }
}
