//! What every composition shares: the shape of a composition's input and
//! output, Go-compatible formatting, lenient decoding and small helpers.

pub mod gojson;
pub mod kinds;
pub mod lenient;
pub mod util;

use serde_json::Value;
use std::collections::BTreeMap;

/// A resource the composition needs to see besides the XR: by name, or by
/// labels; namespace None for a cluster-scoped one.
#[derive(Debug, Clone, PartialEq)]
pub struct Requirement {
    pub api_version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: Option<String>,
    pub labels: Option<BTreeMap<String, String>>,
}

impl Requirement {
    /// A resource by name.
    pub fn named(api_version: &str, kind: &str, namespace: &str, name: &str) -> Self {
        Requirement {
            api_version: api_version.into(),
            kind: kind.into(),
            namespace: (!namespace.is_empty()).then(|| namespace.into()),
            name: Some(name.into()),
            labels: None,
        }
    }
}

/// One reconcile's view.
#[derive(Debug, Clone, Default)]
pub struct Input {
    /// The observed XR.
    pub xr: Value,
    /// Observed composed resources, by composition resource name.
    pub observed: BTreeMap<String, Value>,
    /// Required resources, by requirement name: present once Crossplane has
    /// resolved it (with no items if nothing matched).
    pub required: BTreeMap<String, Vec<Value>>,
}

impl Input {
    /// The first item of a requirement, None until it resolves to one.
    pub fn first(&self, requirement: &str) -> Option<&Value> {
        self.required.get(requirement).and_then(|items| items.first())
    }

    pub fn resolved(&self, requirement: &str) -> bool {
        self.required.contains_key(requirement)
    }
}

/// A desired composed resource and its readiness.
#[derive(Debug, Clone, PartialEq)]
pub struct Composed {
    pub object: Value,
    pub ready: bool,
}

/// The condition a composition sets on its XR, next to Crossplane's Ready
/// and Synced: the workload's view of health.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Condition {
    pub status: bool,
    pub reason: String,
    pub message: String,
}

/// What one composition returns.
#[derive(Debug, Clone, Default)]
pub struct Output {
    pub composed: BTreeMap<String, Composed>,
    pub status: Value,
    pub condition: Condition,
}

/// A composition's refusal: Crossplane gets a fatal result with it and
/// applies nothing (never a desired state that would tear down a running
/// workload because an input went missing).
pub type Result<T> = std::result::Result<T, String>;

/// Says whether an observed resource is ready.
pub type ReadyFn = Box<dyn Fn(Option<&Value>) -> bool>;
