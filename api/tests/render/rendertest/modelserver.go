package main

import "strings"

func assertModelServer(r *render) {
	kase, state, status, name, ns, composed := r.kase, r.state, r.status, r.name, r.ns, r.composed
	check := r.check
	geo, cpu := kase == "geo", kase == "cpu"

	sites := []string{"protected"}
	locations := map[string]string{"protected": "si-ske-demo", "recovery": "onprem-ams"}
	if geo {
		sites = append(sites, "recovery")
	}
	served := name
	if geo {
		served = "meta-llama/Llama-3.1-70B-Instruct"
	}
	check(str(status, "model") == served, "status.model %q, want %q", str(status, "model"), served)
	check(str(status, "endpoint") == "http://"+name+"-kserve-workload-svc."+ns+".svc:8000/v1", "status.endpoint %q", str(status, "endpoint"))
	pool := name + "-inference-pool"
	if cpu {
		pool = ""
	}
	check(str(status, "inferencePool") == pool, "status.inferencePool %q, want %q", str(status, "inferencePool"), pool)
	check(str(composed["dashboard"], "kind") == "GrafanaDashboard" && str(composed["dashboard"], "spec", "uid") == str(status, "dashboardUid"),
		"dashboard and status.dashboardUid")
	check(len(list(status, "sites")) == len(sites), "status.sites %s", repr(get(status, "sites")))

	for _, s := range sites {
		for key, obj := range composed {
			if !strings.HasPrefix(key, s+"-") {
				continue
			}
			check(str(obj, "kind") == "Object" && equal(get(obj, "spec", "providerConfigRef"),
				M{"kind": "ClusterProviderConfig", "name": locations[s]}), "%s: Object in location %s", key, locations[s])
			check(str(r.live(key), "metadata", "namespace") == ns, "%s: must land in the project namespace", key)
			if str(r.live(key), "kind") == "Secret" {
				check(!has(r.live(key), "data") && !has(r.live(key), "stringData"), "%s: secret data must not be in the Object spec", key)
			}
		}
		srv := r.live(s + "-server")
		check(str(srv, "apiVersion") == "serving.kserve.io/v1alpha2" && str(srv, "kind") == "LLMInferenceService" &&
			str(srv, "metadata", "name") == name, "%s: LLMInferenceService %s", s, name)
		check(equal(get(srv, "spec", "labels"), M{"ai.cndev.nl/modelserver": name}),
			"%s: only our label on what KServe creates (its part-of label finds its Deployments): %s", s, repr(get(srv, "spec", "labels")))
		check(str(srv, "spec", "model", "name") == served, "%s: served as %q: %s", s, served, repr(get(srv, "spec", "model")))
		replicas := 1
		switch {
		case geo && s == "protected":
			replicas = 3
		case geo:
			replicas = 0
		}
		check(equal(get(srv, "spec", "replicas"), replicas), "%s: replicas %s, want %d", s, repr(get(srv, "spec", "replicas")), replicas)
		check((get(srv, "spec", "router", "scheduler") != nil) == !cpu, "%s: llm-d's scheduler unless prefixCacheAware is off: %s", s, repr(get(srv, "spec", "router")))
		main := get(srv, "spec", "template", "containers", 0)
		gpu := get(main, "resources", "limits", "nvidia.com/gpu")
		switch {
		case cpu:
			check(gpu == nil && str(main, "image") == "docker.io/vllm/vllm-openai-cpu:v0.23.0" &&
				equal(get(main, "securityContext", "runAsNonRoot"), false), "%s: CPU only: %s", s, repr(main))
		case geo:
			check(equal(gpu, "2") && equal(get(srv, "spec", "parallelism", "tensor"), 2), "%s: two GPUs, tensor parallel: %s", s, repr(main))
			check(equal(get(main, "args"), L{"--max-model-len=32768", "--gpu-memory-utilization=0.92"}), "%s: vLLM flags %s", s, repr(get(main, "args")))
			check(str(srv, "spec", "template", "serviceAccountName") == name+"-model", "%s: the token's ServiceAccount", s)
			sa := r.live(s + "-serviceaccount")
			check(str(sa, "kind") == "ServiceAccount" && str(sa, "secrets", 0, "name") == name+"-model-token", "%s: ServiceAccount %s", s, repr(sa))
			ref := get(composed[s+"-token"], "spec", "references", 0)
			check(str(ref, "patchesFrom", "name") == "hf-token" && str(ref, "toFieldPath") == "data.HF_TOKEN",
				"%s: the token copied from the Project's Secret: %s", s, repr(ref))
			check(str(srv, "spec", "template", "tolerations", 0, "key") == "nvidia.com/gpu", "%s: tolerations", s)
		default:
			check(equal(gpu, "1") && !has(srv, "parallelism", "spec") && !has(main, "image"), "%s: one GPU, KServe's image: %s", s, repr(main))
			check(r.live(s+"-token") == nil && !has(srv, "spec", "template", "serviceAccountName"), "%s: no token without tokenSecretRef", s)
		}
		pm := r.live(s + "-podmonitor")
		check(str(pm, "kind") == "PodMonitor" && str(pm, "spec", "selector", "matchLabels", "app.kubernetes.io/name") == name &&
			equal(get(pm, "spec", "podMetricsEndpoints", 0, "targetPort"), 8000), "%s: vLLM's metrics: %s", s, repr(get(pm, "spec")))
		rule := r.live(s + "-prometheusrule")
		check((rule != nil) == (!cpu && replicas > 0), "%s: alerts only with replicas, unless disabled", s)
		if rule != nil {
			check(len(list(rule, "spec", "groups", 0, "rules")) == 4, "%s: four alerts", s)
		}
	}

	ready := str(r.conds["ServerReady"], "status")
	switch {
	case kase == "minimal" && state == "observed":
		check(ready == "True" && equal(get(status, "ready"), true), "ServerReady %s, status %s", ready, repr(status))
	case geo && state == "observed":
		check(ready == "False" && strings.Contains(str(status, "message"), "Insufficient nvidia.com/gpu"),
			"KServe's reason in the message: %q", str(status, "message"))
	default:
		check(ready == "False", "ServerReady %s before KServe reports", ready)
	}
}
