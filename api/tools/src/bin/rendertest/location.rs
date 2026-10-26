use basis_tools::doc::{self, strs};
use basis_tools::{at, has, s};
use serde_json::{Value, json};

use crate::{Render, eq, list_str, repr, same_keys, set, v};

pub fn assert(r: &Render) {
    let (kase, state, status, name) = (r.kase.as_str(), r.state.as_str(), &r.status, r.name.as_str());
    let check = |ok: bool, msg: String| r.check(ok, msg);
    let secret_ref = v(at!(&r.xr, "spec", "credentials", "secretRef"));

    check(same_keys(&r.composed, &set(&["providerconfig", "prometheus-role", "cnpg", "prometheus-operator", "valkey", "agent-router", "kserve"])),
        format!("composed resources {}", list_str(&r.keys())));

    // --- the ClusterProviderConfig the Project/PostgresCluster compositions use
    let pc = r.get("providerconfig");
    check(s!(pc, "kind") == "ClusterProviderConfig" && s!(pc, "metadata", "name") == name, "ClusterProviderConfig must be named after the location".into());
    let key = if has!(secret_ref, "key") { s!(secret_ref, "key") } else { "kubeconfig" };
    check(eq(at!(pc, "spec", "credentials"), json!({"source": "Secret", "secretRef": {
        "namespace": v(at!(secret_ref, "namespace")), "name": v(at!(secret_ref, "name")), "key": key}})),
        format!("credentials {}", repr(at!(pc, "spec", "credentials"))));

    // --- Objects in the location
    for k in ["prometheus-role", "cnpg", "prometheus-operator", "valkey", "agent-router", "kserve"] {
        let o = r.get(k);
        check(s!(o, "kind") == "Object", format!("{k}: must be an Object"));
        check(eq(at!(o, "metadata", "namespace"), v(at!(secret_ref, "namespace")).clone()), format!("{k}: not next to the kubeconfig Secret"));
        check(s!(o, "metadata", "name").starts_with(&format!("{name}-")), format!("{k}: name not prefixed with the location"));
        check(eq(at!(o, "spec", "providerConfigRef"), json!({"kind": "ClusterProviderConfig", "name": name})), format!("{k}: providerConfigRef"));
    }
    let role = r.get("prometheus-role");
    let deletes = strs(at!(role, "spec", "managementPolicies")).iter().any(|p| p == "Delete");
    check(!deletes, "the Prometheus ClusterRole must outlive the Location (projects' bindings there use it)".into());
    check(s!(role, "spec", "forProvider", "manifest", "metadata", "name") == "basis:project-prometheus",
        "the ClusterRole name must match what the Project composition binds".into());
    let installed = doc::load(&doc::root().join("install").join("project-prometheus-role.yaml").to_string_lossy());
    check(installed.as_ref().is_ok_and(|i| eq(at!(role, "spec", "forProvider", "manifest", "rules"), v(at!(i, "rules")).clone())),
        "ClusterRole rules differ from install/project-prometheus-role.yaml".into());
    for (k, service) in [("cnpg", "v1.postgresql.cnpg.io"), ("prometheus-operator", "v1.monitoring.coreos.com"), ("valkey", "v1alpha1.valkey.io"),
        ("agent-router", "v1beta1.aigateway.envoyproxy.io"), ("kserve", "v1alpha2.serving.kserve.io")]
    {
        let o = r.get(k);
        check(eq(at!(o, "spec", "managementPolicies"), json!(["Observe"])), format!("{k}: must only observe"));
        check(s!(o, "spec", "forProvider", "manifest", "metadata", "name") == service, format!("{k}: APIService"));
    }

    // --- status
    let creating = json!({"ready": false, "connected": false, "providerConfig": null, "operators": null,
        "message": "Creating the ClusterProviderConfig"});
    let expected = match format!("{kase}/{state}").as_str() {
        "minimal/empty" | "unreachable/empty" | "ready/empty" => creating,
        "minimal/observed" => json!({"ready": false, "connected": true, "providerConfig": name,
            "operators": {"cloudnativepg": true, "prometheusOperator": false, "valkey": false, "agentRouter": false, "kserve": false},
            "message": "Connected; the Prometheus Operator CRDs not installed (install it there, see deps/README.md)"}),
        "ready/observed" => json!({"ready": true, "connected": true, "providerConfig": name,
            "operators": {"cloudnativepg": true, "prometheusOperator": true, "valkey": false, "agentRouter": false, "kserve": false},
            "message": format!("Location {name} is ready")}),
        "unreachable/observed" => json!({"ready": false, "connected": false, "providerConfig": name, "operators": null,
            "message": "Can't reach the cluster: connect failed: dial tcp 10.0.0.9:6443: i/o timeout"}),
        _ => {
            check(false, format!("no expectations for case {kase}/{state}"));
            Value::Null
        }
    };
    for (k, want) in expected.as_object().into_iter().flatten() {
        check(eq(at!(status, k), want.clone()), format!("status.{k} = {}, want {}", repr(at!(status, k)), repr(Some(want))));
    }

    // function-basis marks the composed resources ready, which makes the XR
    // Ready; ready/observed has no Valkey operator and is Ready all the same
    // (it's optional).
    let want = if eq(at!(status, "ready"), json!(true)) { "True" } else { "False" };
    check(s!(r.cond("Ready"), "status") == want, format!("XR Ready {}, want {want}", repr(r.conds.get("Ready"))));
    check(s!(r.cond("LocationReady"), "status") == want, format!("LocationReady {}", repr(r.conds.get("LocationReady"))));
}
