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

use k8s_openapi::api::rbac::v1::{ClusterRole, PolicyRule};
use k8s_openapi::kube_aggregator::pkg::apis::apiregistration::v1::APIService;
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::common::kinds::crds::provider_kubernetes::{cluster_provider_config as cpc, object};
use crate::common::kinds::{Labels, manifest, meta, to_value};
use crate::common::util::{as_str, condition, condition_true, dig, dig_str, live, or};
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
    let labels = Labels::from([
        ("app.kubernetes.io/managed-by".to_string(), "crossplane".to_string()),
        ("app.kubernetes.io/part-of".to_string(), "basis".to_string()),
        ("platform.cndev.nl/location".to_string(), name.to_string()),
    ]);
    let mut out = Output::default();

    let pc = input.observed.get("providerconfig");
    let role = input.observed.get("prometheus-role");
    let synced = condition(role, "Synced");
    let role_ready = condition_true(role, "Ready");
    let connected = synced.is_some_and(|s| s.get("status").and_then(Value::as_str) == Some("True")) && role_ready;
    let installed: BTreeMap<&str, bool> =
        OPERATORS.iter().map(|o| (o.key, live(input.observed.get(o.key)).is_some())).collect();

    out.composed.insert("providerconfig".into(), Composed { ready: pc.is_some(), object: to_value(&cpc::ClusterProviderConfig {
        metadata: meta(name, "", &labels),
        spec: cpc::ClusterProviderConfigSpec {
            credentials: cpc::ClusterProviderConfigCredentials {
                source: cpc::ClusterProviderConfigCredentialsSource::Secret,
                secret_ref: Some(cpc::ClusterProviderConfigCredentialsSecretRef {
                    namespace: ns.into(), name: as_str(r.get("name")).into(), key: or(as_str(r.get("key")), "kubeconfig").into() }),
                env: None,
                fs: None,
            },
            identity: None,
        },
        status: None,
    })});
    let object = |key: &str, policies: &[&str], manifest: Value| object::Object {
        metadata: meta(&format!("{name}-{key}"), ns, &labels),
        spec: object::ObjectSpec {
            provider_config_ref: Some(object::ObjectProviderConfigRef { kind: "ClusterProviderConfig".into(), name: name.into() }),
            management_policies: Some(policies.iter().map(|p| p.to_string()).collect()),
            for_provider: object::ObjectForProvider { manifest: self::manifest(manifest), ..Default::default() },
            ..Default::default()
        },
        status: None,
    };
    let rule = |groups: &[&str], resources: &[&str], urls: &[&str], verbs: &[&str]| {
        let strings = |v: &[&str]| (!v.is_empty()).then(|| v.iter().map(|s| s.to_string()).collect());
        PolicyRule { api_groups: strings(groups), resources: strings(resources), non_resource_urls: strings(urls),
            verbs: verbs.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    };
    let cluster_role = ClusterRole {
        metadata: meta("basis:project-prometheus", "", &Labels::from([
            ("app.kubernetes.io/managed-by".to_string(), "crossplane".to_string()),
            ("app.kubernetes.io/part-of".to_string(), "basis".to_string()),
        ])),
        rules: Some(vec![
            rule(&[""], &["nodes", "nodes/metrics", "nodes/proxy", "services", "endpoints", "pods"], &[], &["get", "list", "watch"]),
            rule(&["discovery.k8s.io"], &["endpointslices"], &[], &["get", "list", "watch"]),
            rule(&[], &[], &["/metrics", "/metrics/cadvisor"], &["get"]),
        ]),
        ..Default::default()
    };
    // Projects' Prometheus ClusterRoleBindings there point at it: leave it
    // when the Location goes (no Delete), which also lets the Location be
    // removed while the cluster is unreachable.
    out.composed.insert("prometheus-role".into(), Composed { ready: role_ready,
        object: to_value(&object("prometheus-role", &["Observe", "Create", "Update", "LateInitialize"], to_value(&cluster_role))) });
    for o in OPERATORS {
        let api_service = APIService { metadata: meta(o.api_service, "", &Labels::new()), ..Default::default() };
        out.composed.insert(o.key.into(), Composed { ready: installed[o.key] || o.optional,
            object: to_value(&object(o.key, &["Observe"], to_value(&api_service))) });
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
