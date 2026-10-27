//! Building the operator kinds the compositions write from their generated
//! types (basis-crds, kopium). Every optional field there is an Option that
//! is skipped when None, so an object carries only what the composition
//! sets: the helpers turn an empty map, list or string into None.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::BTreeMap;

pub use basis_crds as crds;
use crds::grafana::grafana_dashboard as gd;
use crds::prometheus::prometheus_rule;
use crds::provider_kubernetes::object;

pub type Labels = BTreeMap<String, String>;

/// A namespaced object's metadata.
pub fn meta(name: &str, namespace: &str, labels: &Labels) -> ObjectMeta {
    ObjectMeta { name: Some(name.into()), namespace: str_opt(namespace), labels: map_opt(labels.clone()), ..Default::default() }
}

/// None for an empty map.
pub fn map_opt<V>(m: BTreeMap<String, V>) -> Option<BTreeMap<String, V>> {
    (!m.is_empty()).then_some(m)
}

/// None for an empty list.
pub fn vec_opt<T>(v: Vec<T>) -> Option<Vec<T>> {
    (!v.is_empty()).then_some(v)
}

/// None for an empty string.
pub fn str_opt(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

/// A quantity map (resources.requests/limits) as the CRDs type it.
pub fn quantities(m: Labels) -> BTreeMap<String, IntOrString> {
    m.into_iter().map(|(k, v)| (k, IntOrString::String(v))).collect()
}

/// One of a CRD enum's values, from what the XR says (its XRD has the same
/// enum, so only a value the API server would have refused fails).
pub fn enum_value<T: DeserializeOwned>(field: &str, value: &str) -> crate::common::Result<T> {
    serde_json::from_value(Value::String(value.into())).map_err(|_| format!("{field}: unsupported value {value:?}"))
}

/// A core type as a CRD's own copy of it (kopium types a pod's security
/// context, a label selector, a PVC spec ... anew in every CRD that embeds
/// one): the same JSON, so it always converts.
pub fn retype<T: DeserializeOwned>(object: &impl Serialize) -> T {
    serde_json::from_value(to_value(object)).expect("a CRD's copy of a core type")
}

/// An object as the JSON the function returns.
pub fn to_value<T: Serialize>(object: &T) -> Value {
    serde_json::to_value(object).expect("objects serialise")
}

/// An object as a provider-kubernetes Object's spec.forProvider.manifest.
pub fn manifest(object: Value) -> BTreeMap<String, Value> {
    match object {
        Value::Object(m) => m.into_iter().collect(),
        _ => BTreeMap::new(),
    }
}

/// Labels kept as JSON (a composition's own labels) as a label map; a value
/// that isn't a string is left out.
pub fn labels_of(m: &serde_json::Map<String, Value>) -> Labels {
    m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()
}

/// A provider-kubernetes Object that applies manifest in location (its
/// ClusterProviderConfig), watched so that status changes show up without
/// waiting for the poll interval (needs the provider's --enable-watches).
pub fn location_object(mut metadata: ObjectMeta, location: &str, manifest: Value, references: Vec<object::ObjectReferences>) -> object::Object {
    metadata.annotations = Some(Labels::from([("platform.cndev.nl/location".to_string(), location.to_string())]));
    object::Object {
        metadata,
        spec: object::ObjectSpec {
            provider_config_ref: Some(object::ObjectProviderConfigRef { kind: "ClusterProviderConfig".into(), name: location.into() }),
            watch: Some(true),
            references: vec_opt(references),
            for_provider: object::ObjectForProvider { manifest: self::manifest(manifest), ..Default::default() },
            ..Default::default()
        },
        status: None,
    }
}

/// The references that patch a Secret's data and type from namespace/name
/// on the control plane, so its values never appear in the Object's spec.
pub fn secret_copy(namespace: &str, name: &str) -> Vec<object::ObjectReferences> {
    ["data", "type"]
        .iter()
        .map(|field| object::ObjectReferences {
            patches_from: Some(object::ObjectReferencesPatchesFrom {
                api_version: Some("v1".into()),
                kind: Some("Secret".into()),
                name: name.into(),
                namespace: Some(namespace.into()),
                field_path: field.to_string(),
            }),
            ..Default::default()
        })
        .collect()
}

/// The reference that patches one field of a Secret on the control plane,
/// namespace/name's field, into the Object's to (data.<key> paths).
pub fn secret_field_copy(namespace: &str, name: &str, field: &str, to: &str) -> Vec<object::ObjectReferences> {
    vec![object::ObjectReferences {
        patches_from: Some(object::ObjectReferencesPatchesFrom {
            api_version: Some("v1".into()),
            kind: Some("Secret".into()),
            name: name.into(),
            namespace: Some(namespace.into()),
            field_path: field.into(),
        }),
        to_field_path: Some(to.into()),
        ..Default::default()
    }]
}

/// Alert rules (as alert_rules renders them) as a PrometheusRule's.
pub fn rules(rules: Vec<Value>) -> crate::common::Result<Vec<prometheus_rule::PrometheusRuleGroupsRules>> {
    rules.into_iter().map(serde_json::from_value).collect::<Result<_, _>>().map_err(|e| format!("alert rules: {e}"))
}

/// An alerting rule: its labels, a summary.
pub fn alert(name: &str, r#for: &str, expr: String, labels: &Labels, summary: String) -> prometheus_rule::PrometheusRuleGroupsRules {
    prometheus_rule::PrometheusRuleGroupsRules {
        alert: Some(name.into()),
        r#for: Some(r#for.into()),
        expr: IntOrString::String(expr),
        labels: map_opt(labels.clone()),
        annotations: Some(Labels::from([("summary".to_string(), summary)])),
        ..Default::default()
    }
}

/// A dashboard in the Project's Grafana (the instances scoped to namespace),
/// its JSON resynced every 10 minutes.
pub fn scoped_dashboard(metadata: ObjectMeta, namespace: &str, folder: &str, uid: String, json: String) -> gd::GrafanaDashboard {
    gd::GrafanaDashboard {
        metadata,
        spec: gd::GrafanaDashboardSpec {
            instance_selector: gd::GrafanaDashboardInstanceSelector {
                match_labels: Some(Labels::from([("dashboards.paas.cndev.nl/scope".to_string(), namespace.to_string())])),
                ..Default::default()
            },
            folder: Some(folder.into()),
            uid: Some(uid),
            resync_period: Some("10m".into()),
            json: Some(json),
            ..Default::default()
        },
        status: None,
    }
}

/// A PrometheusRule with one group of rules.
pub fn prometheus_rule(metadata: ObjectMeta, group: String, rules: Vec<prometheus_rule::PrometheusRuleGroupsRules>) -> prometheus_rule::PrometheusRule {
    prometheus_rule::PrometheusRule {
        metadata,
        spec: prometheus_rule::PrometheusRuleSpec {
            groups: Some(vec![prometheus_rule::PrometheusRuleGroups { name: group, rules: Some(rules), ..Default::default() }]),
        },
        status: None,
    }
}
