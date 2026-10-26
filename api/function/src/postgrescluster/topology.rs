//! Which member runs the primary, and how a change of primary site is
//! carried out. CloudNativePG's distributed topology: every member lists the
//! others in externalClusters and replica.primary names the primary. Moving
//! the primary (spec.geoReplication.primarySite) is a two-step handshake
//! across reconciles:
//!
//!  1. Switchover: every member's replica.primary names the target, but the
//!     target keeps naming the current primary (prev) until prev, demoted,
//!     publishes a demotion token. Then the target is promoted with it.
//!  2. Failover: the target is promoted right away, without a token.
//!
//! status.primaryLocation (prev) and status.promotionToken carry the state.

use serde::Serialize;
use std::collections::BTreeMap;

use super::observed::ClusterStatus;

/// The role of a member in the topology.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// No role decided.
    #[default]
    #[serde(rename = "")]
    Unset,
    Primary,
    Replica,
    /// The switchover target, waiting for the demotion token.
    Promoting,
}

// Promotion modes (spec.geoReplication.promotion).
pub const SWITCHOVER: &str = "Switchover";
pub const FAILOVER: &str = "Failover";

/// What the state machine needs to know about a member.
#[derive(Debug, Clone, Default)]
pub struct TopologyMember {
    pub location: String,
    /// The member's name in the distributed topology (its archive folder).
    pub topology: String,
    pub status: ClusterStatus,
}

/// The decided topology.
#[derive(Debug, Clone, Default)]
pub struct Placement {
    /// Where the primary should be, and where it was (status.primaryLocation).
    pub target: String,
    pub prev: String,
    /// Where the primary is now: prev while waiting for its demotion token.
    pub current: String,
    /// Waiting for prev's demotion token (switchover in progress).
    pub waiting: bool,
    /// The token the target is (or was) promoted with.
    pub token: String,
    /// By location.
    pub members: BTreeMap<String, MemberPlacement>,
}

/// One member's replica settings and role.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemberPlacement {
    pub role: Role,
    pub primary: String,
    pub source: String,
    pub promotion_token: String,
}

/// Decides the topology. members are in order (protected first); target is
/// the location the spec asks for, prev the one status records (or the
/// protected location), token the promotion token status records.
pub fn place(members: &[TopologyMember], target: &str, prev: &str, promotion: &str, token: &str) -> Placement {
    let by_location: BTreeMap<&str, &TopologyMember> = members.iter().map(|m| (m.location.as_str(), m)).collect();
    let empty = TopologyMember::default();
    let get = |l: &str| *by_location.get(l).unwrap_or(&&empty);
    let mut p = Placement { target: target.into(), prev: prev.into(), current: target.into(), ..Default::default() };
    if target == prev {
        // Steady: keep the token the primary was promoted with.
        p.token = token.into();
    } else if promotion != FAILOVER {
        // Switchover: prev is demoted (it names the target as primary);
        // promote the target once prev publishes a demotion token no member
        // has been promoted with yet (an old token from an earlier demotion
        // would be refused).
        let demotion = &get(prev).status.demotion_token;
        let used = members.iter().any(|m| !m.status.last_promotion_token.is_empty() && &m.status.last_promotion_token == demotion);
        if !demotion.is_empty() && !used {
            p.token = demotion.clone();
        } else {
            p.waiting = true;
            p.current = prev.into();
        }
    }

    let (target_m, prev_m) = (get(target), get(prev));
    for m in members {
        let mut mp = MemberPlacement { role: Role::Replica, primary: target_m.topology.clone(), source: target_m.topology.clone(), ..Default::default() };
        if m.location == target {
            if p.waiting {
                mp.primary = prev_m.topology.clone();
            }
            // A primary's source is only used once it is demoted: the member
            // it was promoted from, or (steady) the first other one.
            mp.source = prev_m.topology.clone();
            if target == prev
                && let Some(other) = members.iter().find(|o| o.location != target) {
                    mp.source = other.topology.clone();
                }
            if !p.waiting {
                mp.promotion_token = p.token.clone();
            }
        }
        if m.location == p.current {
            mp.role = Role::Primary;
        } else if p.waiting && m.location == target {
            mp.role = Role::Promoting;
        }
        p.members.insert(m.location.clone(), mp);
    }
    p
}
