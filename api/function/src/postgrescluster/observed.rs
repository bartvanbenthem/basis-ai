//! Reading what the locations report: CNPG Clusters, Barman Cloud
//! ObjectStores and Databases.

use serde_json::Value;
use std::collections::BTreeMap;

use crate::common::lenient::decode;
use crate::common::util::dig;
use crate::lenient;

/// Normalises the observed composed resources: a provider-kubernetes Object
/// stands for the object it manages in its location (its
/// status.atProvider.manifest), so the members read live CNPG status as if
/// the objects were local. An Object whose manifest isn't reported yet is
/// left out.
pub fn live(observed: &BTreeMap<String, Value>) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (name, obj) in observed {
        let kind = obj.get("kind").and_then(Value::as_str).unwrap_or("");
        let api_version = obj.get("apiVersion").and_then(Value::as_str).unwrap_or("");
        if kind == "Object" && api_version.starts_with("kubernetes.m.crossplane.io/") {
            if let Some(m) = dig(obj, &["status", "atProvider", "manifest"]).filter(|m| m.as_object().is_some_and(|m| !m.is_empty())) {
                out.insert(name.clone(), m.clone());
            }
            continue;
        }
        out.insert(name.clone(), obj.clone());
    }
    out
}

lenient! {
    pub struct ConditionStatus { #[serde(rename = "type")] pub type_: String, pub status: String }
}

lenient! {
    /// What the composition reads from a CNPG Cluster's status.
    #[serde(rename_all = "camelCase")]
    pub struct ClusterStatus {
        pub phase: String,
        pub instances: i64,
        pub ready_instances: i64,
        pub current_primary: String,
        pub image: String,
        pub conditions: Vec<ConditionStatus>,
        /// Published by a demoted primary; promotes the replica cluster that
        /// sets it as replica.promotionToken (switchover).
        pub demotion_token: String,
        /// The token this cluster was last promoted with.
        pub last_promotion_token: String,
    }
}

impl ClusterStatus {
    pub fn ready(&self) -> bool {
        self.conditions.iter().any(|c| c.type_ == "Ready" && c.status == "True")
    }
}

pub fn read_cluster_status(cluster: Option<&Value>) -> ClusterStatus {
    cluster.and_then(|c| c.get("status")).map(decode).unwrap_or_default()
}

lenient! {
    /// One server's entry in a Barman Cloud ObjectStore's status.serverRecoveryWindow.
    #[serde(rename_all = "camelCase")]
    pub struct RecoveryWindow { pub first_recoverability_point: String, pub last_successful_backup_time: String }
}

pub fn read_recovery_window(object_store: Option<&Value>, server: &str) -> RecoveryWindow {
    object_store.and_then(|o| dig(o, &["status", "serverRecoveryWindow", server])).map(decode).unwrap_or_default()
}

/// CNPG has applied a Database.
pub fn database_applied(db: Option<&Value>) -> bool {
    db.and_then(|d| dig(d, &["status", "applied"])).and_then(Value::as_bool).unwrap_or(false)
}
