use basis_tools::{at, has, l, s};
use serde_json::json;

use crate::{Render, eq, repr, v};

pub fn assert(r: &Render) {
    let (kase, state, status, name, ns) = (r.kase.as_str(), r.state.as_str(), &r.status, r.name.as_str(), r.ns.as_str());
    let check = |ok: bool, msg: String| r.check(ok, msg);
    let (geo, cpu) = (kase == "geo", kase == "cpu");

    let mut sites = vec!["protected"];
    let location = |s: &str| if s == "recovery" { "onprem-ams" } else { "si-ske-demo" };
    if geo {
        sites.push("recovery");
    }
    let served = if geo { "meta-llama/Llama-3.1-70B-Instruct" } else { name };
    check(s!(status, "model") == served, format!("status.model {:?}, want {served:?}", s!(status, "model")));
    check(s!(status, "endpoint") == format!("http://{name}-kserve-workload-svc.{ns}.svc:8000/v1"), format!("status.endpoint {:?}", s!(status, "endpoint")));
    let pool = if cpu { String::new() } else { format!("{name}-inference-pool") };
    check(s!(status, "inferencePool") == pool, format!("status.inferencePool {:?}, want {pool:?}", s!(status, "inferencePool")));
    check(s!(r.get("dashboard"), "kind") == "GrafanaDashboard" && s!(r.get("dashboard"), "spec", "uid") == s!(status, "dashboardUid"),
        "dashboard and status.dashboardUid".into());
    check(l!(status, "sites").len() == sites.len(), format!("status.sites {}", repr(at!(status, "sites"))));

    for s in &sites {
        for (key, o) in &r.composed {
            if !key.starts_with(&format!("{s}-")) {
                continue;
            }
            check(s!(o, "kind") == "Object" && eq(at!(o, "spec", "providerConfigRef"), json!({"kind": "ClusterProviderConfig", "name": location(s)})),
                format!("{key}: Object in location {}", location(s)));
            check(s!(r.live(key), "metadata", "namespace") == ns, format!("{key}: must land in the project namespace"));
            if s!(r.live(key), "kind") == "Secret" {
                check(!has!(r.live(key), "data") && !has!(r.live(key), "stringData"), format!("{key}: secret data must not be in the Object spec"));
            }
        }
        let srv = r.live(&format!("{s}-server"));
        check(s!(srv, "apiVersion") == "serving.kserve.io/v1alpha2" && s!(srv, "kind") == "LLMInferenceService" && s!(srv, "metadata", "name") == name,
            format!("{s}: LLMInferenceService {name}"));
        check(eq(at!(srv, "spec", "labels"), json!({"ai.cndev.nl/modelserver": name})),
            format!("{s}: only our label on what KServe creates (its part-of label finds its Deployments): {}", repr(at!(srv, "spec", "labels"))));
        check(s!(srv, "spec", "model", "name") == served, format!("{s}: served as {served:?}: {}", repr(at!(srv, "spec", "model"))));
        let replicas = match (geo, *s) {
            (true, "protected") => 3,
            (true, _) => 0,
            _ => 1,
        };
        check(eq(at!(srv, "spec", "replicas"), json!(replicas)), format!("{s}: replicas {}, want {replicas}", repr(at!(srv, "spec", "replicas"))));
        check(at!(srv, "spec", "router", "scheduler").is_some_and(|x| !x.is_null()) != cpu,
            format!("{s}: llm-d's scheduler unless prefixCacheAware is off: {}", repr(at!(srv, "spec", "router"))));
        let main = v(at!(srv, "spec", "template", "containers", 0));
        let gpu = at!(main, "resources", "limits", "nvidia.com/gpu");
        if cpu {
            check(gpu.is_none_or(|g| g.is_null()) && s!(main, "image") == "docker.io/vllm/vllm-openai-cpu:v0.23.0"
                && eq(at!(main, "securityContext", "runAsNonRoot"), json!(false)), format!("{s}: CPU only: {}", repr(Some(main))));
        } else if geo {
            check(eq(gpu, json!(2)) && eq(at!(srv, "spec", "parallelism", "tensor"), json!(2)), format!("{s}: two GPUs, tensor parallel: {}", repr(Some(main))));
            check(eq(at!(main, "args"), json!(["--max-model-len=32768", "--gpu-memory-utilization=0.92"])), format!("{s}: vLLM flags {}", repr(at!(main, "args"))));
            check(s!(srv, "spec", "template", "serviceAccountName") == format!("{name}-model"), format!("{s}: the token's ServiceAccount"));
            let sa = r.live(&format!("{s}-serviceaccount"));
            check(s!(sa, "kind") == "ServiceAccount" && s!(sa, "secrets", 0, "name") == format!("{name}-model-token"), format!("{s}: ServiceAccount {}", repr(Some(sa))));
            let rf = v(at!(r.get(&format!("{s}-token")), "spec", "references", 0));
            check(s!(rf, "patchesFrom", "name") == "hf-token" && s!(rf, "toFieldPath") == "data.HF_TOKEN",
                format!("{s}: the token copied from the Project's Secret: {}", repr(Some(rf))));
            check(s!(srv, "spec", "template", "tolerations", 0, "key") == "nvidia.com/gpu", format!("{s}: tolerations"));
        } else {
            check(eq(gpu, json!(1)) && !has!(srv, "spec", "parallelism") && !has!(main, "image"), format!("{s}: one GPU, KServe's image: {}", repr(Some(main))));
            check(r.live(&format!("{s}-token")).is_null() && !has!(srv, "spec", "template", "serviceAccountName"), format!("{s}: no token without tokenSecretRef"));
        }
        let pm = r.live(&format!("{s}-podmonitor"));
        check(s!(pm, "kind") == "PodMonitor" && s!(pm, "spec", "selector", "matchLabels", "app.kubernetes.io/name") == name
            && eq(at!(pm, "spec", "podMetricsEndpoints", 0, "targetPort"), json!(8000)), format!("{s}: vLLM's metrics: {}", repr(at!(pm, "spec"))));
        let rule = r.live(&format!("{s}-prometheusrule"));
        check(rule.is_null() != (!cpu && replicas > 0), format!("{s}: alerts only with replicas, unless disabled"));
        if !rule.is_null() {
            check(l!(rule, "spec", "groups", 0, "rules").len() == 4, format!("{s}: four alerts"));
        }
    }

    let ready = s!(r.cond("ServerReady"), "status");
    if kase == "minimal" && state == "observed" {
        check(ready == "True" && eq(at!(status, "ready"), json!(true)), format!("ServerReady {ready}, status {}", repr(Some(status))));
    } else if geo && state == "observed" {
        check(ready == "False" && s!(status, "message").contains("Insufficient nvidia.com/gpu"), format!("KServe's reason in the message: {:?}", s!(status, "message")));
    } else {
        check(ready == "False", format!("ServerReady {ready} before KServe reports"));
    }
}
