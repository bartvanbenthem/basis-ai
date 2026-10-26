//! The gRPC side: dispatches on the XR's kind, asks Crossplane for what the
//! composition needs, runs it, and writes its composed resources, status and
//! condition into the response.

use function_sdk_rust::proto::v1::function_runner_service_server::FunctionRunnerService;
use function_sdk_rust::proto::v1::{
    Ready, Requirements, ResourceSelector, RunFunctionRequest, RunFunctionResponse, Target, resource_selector,
};
use function_sdk_rust::{resource, response};
use serde_json::Value;
use std::collections::BTreeMap;
use tonic::{Request, Response, Status};

use crate::common::{Input, Output, Requirement};
use crate::{genaistack, location, mcpserver, modelgateway, modelserver, postgrescluster, project, valkeycache};

/// function-basis: composes every BASIS API.
#[derive(Debug, Default)]
pub struct Function;

/// What a kind's composition is: its requirements and its compose function,
/// and the condition type it reports.
struct Kind {
    condition: &'static str,
    requirements: fn(&Input) -> BTreeMap<String, Requirement>,
    compose: fn(&Input) -> crate::common::Result<Output>,
}

fn kind(api_version: &str, kind: &str) -> Option<Kind> {
    let k = |condition, requirements, compose| Some(Kind { condition, requirements, compose });
    match (api_version, kind) {
        ("postgres.cndev.nl/v1alpha1", "PostgresCluster") => {
            k("PostgresReady", postgrescluster::requirements, postgrescluster::compose)
        }
        ("cache.cndev.nl/v1alpha1", "ValkeyCache") => k("CacheReady", valkeycache::requirements, valkeycache::compose),
        ("ai.cndev.nl/v1alpha1", "GenAIStack") => k("StackReady", genaistack::requirements, genaistack::compose),
        ("ai.cndev.nl/v1alpha1", "ModelGateway") => k("GatewayReady", modelgateway::requirements, modelgateway::compose),
        ("ai.cndev.nl/v1alpha1", "ModelServer") => k("ServerReady", modelserver::requirements, modelserver::compose),
        ("ai.cndev.nl/v1alpha1", "MCPServer") => k("MCPServerReady", mcpserver::requirements, mcpserver::compose),
        ("platform.cndev.nl/v1alpha1", "Project") => k("ObservabilityReady", project::requirements, project::compose),
        ("platform.cndev.nl/v1alpha1", "Location") => k("LocationReady", location::requirements, location::compose),
        _ => None,
    }
}

#[tonic::async_trait]
impl FunctionRunnerService for Function {
    async fn run_function(&self, request: Request<RunFunctionRequest>) -> Result<Response<RunFunctionResponse>, Status> {
        Ok(Response::new(run(&request.into_inner())))
    }
}

/// Runs the composition for one request.
pub fn run(req: &RunFunctionRequest) -> RunFunctionResponse {
    let mut rsp = response::to(req, response::DEFAULT_TTL);
    let Some(xr) = req.observed.as_ref().and_then(|o| o.composite.as_ref()).and_then(|c| c.resource.as_ref()) else {
        response::fatal(&mut rsp, "cannot get observed composite resource");
        return rsp;
    };
    let xr = resource::struct_to_json(xr);
    let api_version = xr.get("apiVersion").and_then(Value::as_str).unwrap_or("").to_string();
    let kind_name = xr.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
    let Some(k) = kind(&api_version, &kind_name) else {
        let gvk = api_version.split_once('/').map(|(g, v)| format!("{g}/{v}, Kind={kind_name}"));
        response::fatal(&mut rsp, format!("function-basis doesn't compose {}", gvk.unwrap_or(kind_name)));
        return rsp;
    };

    let input = Input { observed: observed(req), required: required(req), xr };
    let xr_name = input.xr.pointer("/metadata/name").and_then(|v| v.as_str()).unwrap_or("");
    tracing::debug!(xr = xr_name, kind = kind_name.as_str(), "composing");
    // Ask for the requirements every time: Crossplane calls again once
    // they're resolved, until they settle.
    set_requirements(&mut rsp, &(k.requirements)(&input));

    let out = match (k.compose)(&input) {
        Ok(out) => out,
        Err(msg) => {
            response::fatal(&mut rsp, msg);
            return rsp;
        }
    };

    let desired = rsp.desired.get_or_insert_default();
    for (name, c) in &out.composed {
        let Value::Object(map) = &c.object else { continue };
        let r = desired.resources.entry(name.clone()).or_default();
        // The whole resource, as this function desires it.
        r.resource = Some(resource::json_to_struct(map));
        resource::set_ready(r, if c.ready { Ready::True } else { Ready::False });
    }

    // Over what earlier pipeline steps set.
    let xr = desired.composite.get_or_insert_default();
    let target = xr.resource.get_or_insert_default();
    let mut status = target.fields.get("status").map(resource::pb_to_json).unwrap_or(Value::Null);
    if !status.is_object() {
        status = Value::Object(Default::default());
    }
    if let (Some(cur), Value::Object(new)) = (status.as_object_mut(), &out.status) {
        for (k, v) in new {
            cur.insert(k.clone(), v.clone());
        }
    }
    target.fields.insert("status".into(), resource::json_to_pb(&status));

    let cond = if out.condition.status {
        response::condition_true(&mut rsp, k.condition, out.condition.reason.clone())
    } else {
        response::condition_false(&mut rsp, k.condition, out.condition.reason.clone())
    };
    cond.message = Some(out.condition.message.clone());
    cond.target = Some(Target::Composite as i32);
    rsp
}

/// The observed composed resources as JSON, by composition resource name.
fn observed(req: &RunFunctionRequest) -> BTreeMap<String, Value> {
    req.observed
        .as_ref()
        .map(|o| {
            o.resources
                .iter()
                .filter_map(|(k, r)| r.resource.as_ref().map(|s| (k.clone(), resource::struct_to_json(s))))
                .collect()
        })
        .unwrap_or_default()
}

/// The resolved requirements as JSON: a name is present once Crossplane has
/// resolved it.
fn required(req: &RunFunctionRequest) -> BTreeMap<String, Vec<Value>> {
    req.required_resources
        .iter()
        .map(|(name, items)| {
            let items = items.items.iter().filter_map(|r| r.resource.as_ref().map(resource::struct_to_json)).collect();
            (name.clone(), items)
        })
        .collect()
}

fn set_requirements(rsp: &mut RunFunctionResponse, reqs: &BTreeMap<String, Requirement>) {
    let mut requirements = Requirements::default();
    for (key, r) in reqs {
        let m = match (&r.labels, &r.name) {
            (Some(labels), _) => {
                Some(resource_selector::Match::MatchLabels(function_sdk_rust::proto::v1::MatchLabels {
                    labels: labels.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                }))
            }
            (None, Some(name)) => Some(resource_selector::Match::MatchName(name.clone())),
            (None, None) => None,
        };
        let sel = ResourceSelector { api_version: r.api_version.clone(), kind: r.kind.clone(), r#match: m, namespace: r.namespace.clone() };
        requirements.resources.insert(key.clone(), sel);
    }
    rsp.requirements = Some(requirements);
}

#[cfg(test)]
mod tests {
    use super::*;
    use function_sdk_rust::proto::v1::{Resource, Resources, Severity, State};
    use serde_json::json;

    fn res(v: Value) -> Resource {
        Resource { resource: Some(resource::json_to_struct(v.as_object().unwrap())), ..Default::default() }
    }

    fn request(xr: Value, required: &[(&str, Value)]) -> RunFunctionRequest {
        RunFunctionRequest {
            observed: Some(State { composite: Some(res(xr)), ..Default::default() }),
            required_resources: required.iter().map(|(k, v)| (k.to_string(), Resources { items: vec![res(v.clone())] })).collect(),
            ..Default::default()
        }
    }

    fn match_name(rsp: &RunFunctionResponse, key: &str) -> String {
        match rsp.requirements.as_ref().and_then(|r| r.resources.get(key)).and_then(|s| s.r#match.clone()) {
            Some(resource_selector::Match::MatchName(n)) => n,
            _ => String::new(),
        }
    }

    fn json_of(r: &Resource) -> Value {
        resource::struct_to_json(r.resource.as_ref().unwrap())
    }

    fn cluster() -> Value {
        json!({"apiVersion": "postgres.cndev.nl/v1alpha1", "kind": "PostgresCluster",
            "metadata": {"name": "orders-db", "namespace": "payments"}, "spec": {}})
    }

    fn project() -> Value {
        json!({"apiVersion": "platform.cndev.nl/v1alpha1", "kind": "Project",
            "metadata": {"name": "payments"}, "spec": {"locations": {"protected": "si-ske-demo"}}})
    }

    #[test]
    fn asks_for_the_project_and_the_catalogs() {
        let rsp = run(&request(cluster(), &[]));
        assert_eq!(match_name(&rsp, "project"), "payments");
        assert_eq!(match_name(&rsp, "sizes"), "postgres-sizes");
        assert_eq!(match_name(&rsp, "extensions"), "postgres-extensions");
        assert_eq!(rsp.requirements.as_ref().unwrap().resources.len(), 3);
    }

    #[test]
    fn composes_once_the_project_is_there() {
        let rsp = run(&request(cluster(), &[("project", project())]));
        assert!(rsp.results.is_empty(), "results {:?}", rsp.results);
        let desired = rsp.desired.as_ref().unwrap();
        let c = &desired.resources["cluster"];
        assert_eq!(c.ready, Ready::False as i32, "not observed yet");
        assert_eq!(json_of(c)["spec"]["providerConfigRef"]["name"], "si-ske-demo");
        let status = &json_of(desired.composite.as_ref().unwrap())["status"];
        assert_eq!(status["primaryLocation"], "si-ske-demo");
        assert_eq!(rsp.conditions.len(), 1);
        assert_eq!(rsp.conditions[0].r#type, "PostgresReady");
        assert_eq!(rsp.conditions[0].reason, "ClusterNotReady");
        assert_eq!(rsp.conditions[0].target, Some(Target::Composite as i32));
    }

    #[test]
    fn composes_a_valkey_cache() {
        let cache = json!({"apiVersion": "cache.cndev.nl/v1alpha1", "kind": "ValkeyCache",
            "metadata": {"name": "llm-cache", "namespace": "payments"}, "spec": {"mode": "semantic"}});
        let rsp = run(&request(cache, &[("project", project())]));
        assert!(rsp.results.is_empty(), "results {:?}", rsp.results);
        assert_eq!(match_name(&rsp, "project"), "payments");
        let desired = rsp.desired.as_ref().unwrap();
        for key in ["auth-secret", "cluster", "dashboard"] {
            assert!(desired.resources.contains_key(key), "missing {key}");
        }
        let status = &json_of(desired.composite.as_ref().unwrap())["status"];
        assert_eq!(status["location"], "si-ske-demo");
        assert!(status["monitoring"].is_object());
        assert_eq!(rsp.conditions[0].r#type, "CacheReady");
    }

    #[test]
    fn keeps_what_earlier_steps_set_in_the_status() {
        let mut req = request(cluster(), &[("project", project())]);
        req.desired = Some(State { composite: Some(res(json!({"status": {"other": "kept"}}))), ..Default::default() });
        let rsp = run(&req);
        let status = &json_of(rsp.desired.as_ref().unwrap().composite.as_ref().unwrap())["status"];
        assert_eq!(status["other"], "kept");
        assert_eq!(status["primaryLocation"], "si-ske-demo");
    }

    #[test]
    fn refuses_other_kinds() {
        let rsp = run(&request(json!({"apiVersion": "example.org/v1", "kind": "Other", "metadata": {"name": "x"}}), &[]));
        assert_eq!(rsp.results.len(), 1);
        assert_eq!(rsp.results[0].severity, Severity::Fatal as i32);
        assert!(rsp.results[0].message.contains("doesn't compose example.org/v1, Kind=Other"));
    }
}
