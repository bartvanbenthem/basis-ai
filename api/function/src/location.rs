//! Composes a Location (platform.cndev.nl/v1alpha1): a Kubernetes cluster the
//! platform places workloads in.
//!
//! For Location <name>:
//!
//!     providerconfig       ClusterProviderConfig <name> (provider-kubernetes),
//!                          credentials from spec.credentials.secretRef; what the
//!                          Project and workload compositions place objects through
//!     prometheus-role      Object <name>-prometheus-role: ClusterRole
//!                          basis:project-prometheus in the location (as
//!                          ../../install/project-prometheus-role.yaml), which
//!                          every Project's Prometheus there binds to. Never deleted
//!                          by Crossplane: removing the Location leaves it
//!     cnpg,                observe-only Objects for the APIServices
//!     prometheus-operator, v1.postgresql.cnpg.io, v1.monitoring.coreos.com,
//!     valkey, agent-router, v1alpha1.valkey.io, v1beta1.aigateway.envoyproxy.io
//!     kserve               and v1alpha2.serving.kserve.io, which the API server
//!                          registers for every CRD group: small, unlike the CRDs,
//!                          whose schemas would land in the Object's status. The
//!                          Valkey operator, Agent Router and KServe are optional
//!                          and never make a Location unready
//!
//! The Objects live in the namespace of the kubeconfig Secret. Whether the
//! role Object syncs says whether Crossplane reaches the cluster
//! (status.connected); the observe-only Objects say which operators are
//! installed.

use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::common::util::{as_str, condition, condition_true, dig, dig_str, labels_obj, live, or};
use crate::common::{Composed, Condition, Input, Output, Requirement, Result};

/// An APIService that tells an operator is installed.
struct Operator {
    key: &'static str,
    api_service: &'static str,
    optional: bool,
}

const OPERATORS: &[Operator] = &[
    Operator { key: "cnpg", api_service: "v1.postgresql.cnpg.io", optional: false },
    Operator { key: "prometheus-operator", api_service: "v1.monitoring.coreos.com", optional: false },
    Operator { key: "valkey", api_service: "v1alpha1.valkey.io", optional: true },
    Operator { key: "agent-router", api_service: "v1beta1.aigateway.envoyproxy.io", optional: true },
    Operator { key: "kserve", api_service: "v1alpha2.serving.kserve.io", optional: true },
];

/// A Location reads nothing besides its composed resources.
pub fn requirements(_: &Input) -> BTreeMap<String, Requirement> {
    BTreeMap::new()
}

/// Renders the desired state of a Location.
pub fn compose(input: &Input) -> Result<Output> {
    let xr = &input.xr;
    let name = dig_str(xr, &["metadata", "name"]);
    let empty = Value::Object(Default::default());
    let r = dig(xr, &["spec", "credentials", "secretRef"]).filter(|v| v.is_object()).unwrap_or(&empty);
    let ns = as_str(r.get("namespace"));
    let labels = labels_obj(&[
        ("app.kubernetes.io/managed-by", "crossplane"),
        ("app.kubernetes.io/part-of", "basis"),
        ("platform.cndev.nl/location", name),
    ]);
    let mut out = Output::default();

    let pc = input.observed.get("providerconfig");
    let role = input.observed.get("prometheus-role");
    let synced = condition(role, "Synced");
    let role_ready = condition_true(role, "Ready");
    let connected = synced.is_some_and(|s| s.get("status").and_then(Value::as_str) == Some("True")) && role_ready;
    let installed: BTreeMap<&str, bool> =
        OPERATORS.iter().map(|o| (o.key, live(input.observed.get(o.key)).is_some())).collect();

    out.composed.insert("providerconfig".into(), Composed { ready: pc.is_some(), object: json!({
        "apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "ClusterProviderConfig",
        "metadata": {"name": name, "labels": labels},
        "spec": {"credentials": {"source": "Secret", "secretRef": {
            "namespace": ns, "name": r.get("name").cloned().unwrap_or(Value::Null),
            "key": or(as_str(r.get("key")), "kubeconfig")}}},
    })});
    let provider_config_ref = json!({"kind": "ClusterProviderConfig", "name": name});
    out.composed.insert("prometheus-role".into(), Composed { ready: role_ready, object: json!({
        "apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
        "metadata": {"name": format!("{name}-prometheus-role"), "namespace": ns, "labels": labels},
        "spec": {
            "providerConfigRef": provider_config_ref,
            // Projects' Prometheus ClusterRoleBindings there point at it:
            // leave it when the Location goes (no Delete), which also lets
            // the Location be removed while the cluster is unreachable.
            "managementPolicies": ["Observe", "Create", "Update", "LateInitialize"],
            "forProvider": {"manifest": {
                "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole",
                "metadata": {"name": "basis:project-prometheus", "labels": {
                    "app.kubernetes.io/managed-by": "crossplane", "app.kubernetes.io/part-of": "basis"}},
                "rules": [
                    {"apiGroups": [""], "resources": ["nodes", "nodes/metrics", "nodes/proxy", "services", "endpoints", "pods"],
                     "verbs": ["get", "list", "watch"]},
                    {"apiGroups": ["discovery.k8s.io"], "resources": ["endpointslices"], "verbs": ["get", "list", "watch"]},
                    {"nonResourceURLs": ["/metrics", "/metrics/cadvisor"], "verbs": ["get"]},
                ],
            }},
        },
    })});
    for o in OPERATORS {
        out.composed.insert(o.key.into(), Composed { ready: installed[o.key] || o.optional, object: json!({
            "apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
            "metadata": {"name": format!("{name}-{}", o.key), "namespace": ns, "labels": labels},
            "spec": {
                "providerConfigRef": provider_config_ref,
                "managementPolicies": ["Observe"],
                "forProvider": {"manifest": {
                    "apiVersion": "apiregistration.k8s.io/v1", "kind": "APIService",
                    "metadata": {"name": o.api_service}}},
            },
        })});
    }

    let mut missing = vec![];
    if !installed["cnpg"] {
        missing.push("CloudNativePG");
    }
    if !installed["prometheus-operator"] {
        missing.push("the Prometheus Operator CRDs");
    }
    let ready = connected && missing.is_empty();
    let msg = if pc.is_none() {
        "Creating the ClusterProviderConfig".to_string()
    } else if role.is_none() {
        "Connecting".to_string()
    } else if !connected {
        format!("Can't reach the cluster: {}", or(as_str(synced.and_then(|s| s.get("message"))), "waiting for provider-kubernetes"))
    } else if !missing.is_empty() {
        format!("Connected; {} not installed (install it there, see deps/README.md)", missing.join(" and "))
    } else {
        format!("Location {name} is ready")
    };
    let mut status = json!({"ready": ready, "message": msg, "connected": connected});
    if pc.is_some() {
        status["providerConfig"] = json!(name);
    }
    if connected {
        status["operators"] = json!({
            "cloudnativepg": installed["cnpg"], "prometheusOperator": installed["prometheus-operator"],
            "valkey": installed["valkey"], "agentRouter": installed["agent-router"], "kserve": installed["kserve"],
        });
    }
    let reason = if ready {
        "Available"
    } else if connected {
        "OperatorsMissing"
    } else {
        "Connecting"
    };
    out.status = status;
    out.condition = Condition { status: ready, reason: reason.into(), message: msg };
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(observed: &[(&str, Value)]) -> Input {
        Input {
            xr: json!({"metadata": {"name": "dc-a"},
                "spec": {"credentials": {"secretRef": {"namespace": "basis-locations", "name": "dc-a"}}}}),
            observed: observed.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn connected_without_cnpg_isnt_ready_optional_operators_dont_matter() {
        let synced = json!({"status": {"conditions": [{"type": "Synced", "status": "True"}, {"type": "Ready", "status": "True"}]}});
        let installed = json!({"status": {"atProvider": {"manifest": {"kind": "APIService"}}}});
        let out = compose(&input(&[("providerconfig", json!({})), ("prometheus-role", synced), ("prometheus-operator", installed)])).unwrap();
        assert_eq!(out.status["ready"], json!(false));
        assert_eq!(out.status["connected"], json!(true));
        assert_eq!(out.condition.reason, "OperatorsMissing");
        assert_eq!(out.status["message"], "Connected; CloudNativePG not installed (install it there, see deps/README.md)");
        assert!(out.composed["valkey"].ready && !out.composed["cnpg"].ready, "optional operators ready, CloudNativePG not");
        assert_eq!(out.composed["providerconfig"].object["spec"]["credentials"]["secretRef"]["key"], "kubeconfig");
    }

    #[test]
    fn unreachable() {
        let failing = json!({"status": {"conditions": [{"type": "Synced", "status": "False", "message": "connection refused"}]}});
        let out = compose(&input(&[("providerconfig", json!({})), ("prometheus-role", failing)])).unwrap();
        assert_eq!(out.status["message"], "Can't reach the cluster: connection refused");
        assert!(out.status.get("operators").is_none());
    }
}
