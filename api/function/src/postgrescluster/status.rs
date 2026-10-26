//! The XR's status (definition.yaml status), mirrored from CNPG and carrying
//! the pinned sites, backup store and sizing between reconciles.

use serde::Serialize;

use super::observed::{read_cluster_status, read_recovery_window};
use super::spec::{BackupStore, Sites, Sizing};
use super::topology::Role;
use super::{Composition, StatusInput};
use crate::common::Condition;
use crate::common::util::or;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub ready: bool,
    pub phase: String,
    pub instances: i64,
    pub ready_instances: i64,
    pub current_primary: String,
    pub image: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_store: Option<BackupStore>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sizing: Option<Sizing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sites: Option<Sites>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub primary_location: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub primary_site: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub promotion_token: String,
    pub locations: Vec<LocationStatus>,
    pub endpoints: Endpoints,
    pub secrets: Secrets,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<BackupStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitoring: Option<MonitoringStatus>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationStatus {
    pub location: String,
    pub site: String,
    pub role: Role,
    pub ready: bool,
    pub phase: String,
    pub instances: i64,
    pub ready_instances: i64,
    pub current_primary: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoints {
    pub read_write: String,
    pub read_only: String,
    pub read: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pooler: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pooler_read_only: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Secrets {
    pub app: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub superuser: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub server_name: String,
    pub last_successful_backup: String,
    pub first_recoverability_point: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringStatus {
    pub dashboard_uid: String,
}

impl Composition<'_> {
    pub(super) fn status(&self, input: StatusInput<'_>) -> (Status, Condition) {
        let spec = &self.spec;
        let (name, ns) = (self.name.as_str(), self.ns.as_str());
        let p = input.placement;
        let cs = read_cluster_status(input.primary.cluster.as_ref());

        let mut ready = self.problem.is_empty();
        let mut not_ready: Vec<&str> = vec![];
        for m in input.members {
            if !m.status.ready() {
                ready = false;
                not_ready.push(&m.location);
            }
        }
        let phase = or(&cs.phase, "Provisioning").to_string();
        let mut msg = if ready {
            format!("CNPG Cluster {name} is ready ({}/{} instances)", cs.ready_instances, input.primary.instances)
        } else {
            format!("Waiting for CNPG Cluster {name} (phase: {phase}, {}/{} instances ready)", cs.ready_instances, input.primary.instances)
        };
        if input.members.len() > 1 {
            msg = if ready {
                format!("CNPG Cluster {name} is ready: primary in {}, {} replica cluster(s)", p.current, input.members.len() - 1)
            } else {
                format!("Waiting for CNPG Cluster {name} in {}", not_ready.join(", "))
            };
            if p.waiting {
                msg = format!("Switching the primary from {} to {}: waiting for the demotion token of {}", p.prev, p.target, p.prev);
            } else if input.draining {
                msg = format!(
                    "geoReplication is off: switching the primary back to {} before removing the replica cluster in {}",
                    input.protected, input.recovery
                );
            }
        }
        // Until an instance is up, a restored cluster is still recovering.
        if let Some(r) = &spec.restore
            && !ready && cs.ready_instances == 0 && !input.members.is_empty() {
                let up_to = if r.target_time.is_empty() { "latest state".to_string() } else { format!("up to {}", r.target_time) };
                msg = format!("Restoring {name} from backup folder {} ({up_to}); phase: {phase}", r.source.server_name);
            }
        if !self.problem.is_empty() {
            msg = self.problem.clone();
        }

        let mut s = Status {
            ready, phase: phase.clone(), instances: cs.instances, ready_instances: cs.ready_instances,
            current_primary: cs.current_primary.clone(), image: cs.image.clone(), message: msg.clone(),
            sizing: input.sizing.cloned(),
            promotion_token: p.token.clone(),
            endpoints: Endpoints {
                read_write: format!("{name}-rw.{ns}.svc"),
                read_only: format!("{name}-ro.{ns}.svc"),
                read: format!("{name}-r.{ns}.svc"),
                ..Default::default()
            },
            secrets: Secrets { app: format!("{name}-app"), ..Default::default() },
            ..Default::default()
        };
        if !input.store.destination_path.is_empty() {
            s.backup_store = Some(input.store.clone());
        }
        if !input.protected.is_empty() {
            s.sites = Some(Sites { protected: input.protected.into(), recovery: input.recovery.into() });
            s.primary_location = p.current.clone();
            s.primary_site = if !input.recovery.is_empty() && p.current == input.recovery { "recovery" } else { "protected" }.into();
        }
        for m in input.members {
            s.locations.push(LocationStatus {
                location: m.location.clone(), site: m.site.clone(), role: m.placement.role, ready: m.status.ready(),
                phase: or(&m.status.phase, "Provisioning").into(), instances: m.instances,
                ready_instances: m.status.ready_instances, current_primary: m.status.current_primary.clone(),
            });
        }
        if spec.pooler.enabled {
            s.endpoints.pooler = format!("{name}-pooler-rw.{ns}.svc");
            if spec.pooler.read_only {
                s.endpoints.pooler_read_only = format!("{name}-pooler-ro.{ns}.svc");
            }
        }
        if spec.enable_superuser_access {
            s.secrets.superuser = format!("{name}-superuser");
        }
        if spec.backup.enabled {
            let w = read_recovery_window(input.primary.observed.get("objectstore"), &input.primary.topology);
            s.backup = Some(BackupStatus { server_name: input.primary.topology.clone(),
                last_successful_backup: w.last_successful_backup_time, first_recoverability_point: w.first_recoverability_point });
        }
        if spec.monitoring.dashboard() {
            s.monitoring = Some(MonitoringStatus { dashboard_uid: input.dash_uid.into() });
        }

        let reason = if ready {
            "ClusterHealthy"
        } else if !self.problem.is_empty() {
            "NoSite"
        } else {
            "ClusterNotReady"
        };
        (s, Condition { status: ready, reason: reason.into(), message: msg })
    }
}
