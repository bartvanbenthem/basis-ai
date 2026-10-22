package main

import (
	"encoding/base64"
	"strings"
)

func assertModelGateway(r *render) {
	kase, state, status, name, ns, composed := r.kase, r.state, r.status, r.name, r.ns, r.composed
	check := r.check
	exposed := kase == "exposed"
	geo := kase == "geo" || exposed

	sites := []string{"protected"}
	locations := map[string]string{"protected": "si-ske-demo", "recovery": "onprem-ams"}
	active := "protected"
	if geo {
		sites, active = append(sites, "recovery"), "recovery"
	}
	check(str(status, "activeSite") == active, "activeSite %q, want %q", str(status, "activeSite"), active)
	check(str(status, "endpoint") == "http://"+name+"."+ns+".svc/v1" && str(status, "keysSecret") == name+"-keys",
		"status endpoint %q keysSecret %q", str(status, "endpoint"), str(status, "keysSecret"))

	// --- a key per client, generated once and kept; removed clients' go
	keys := mp(composed["keys"], "data")
	clients := set("apps")
	if !geo {
		clients = set("support-bot", "coding-agent")
	}
	got := map[string]bool{}
	for k := range keys {
		got[k] = true
	}
	check(sameKeys(got, clients), "keys for clients %v, want %v", sortedKeys(got), sortedKeys(clients))
	if !geo && state == "observed" {
		raw, _ := base64.StdEncoding.DecodeString(str(keys, "support-bot"))
		check(string(raw) == "bot-key", "support-bot's key must be kept")
	}

	// --- per site: Agent Router in the location
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
		ep := r.live(s + "-envoyproxy")
		check(equal(get(ep, "spec", "provider", "kubernetes", "envoyService"), M{"name": name, "type": "ClusterIP"}),
			"%s: the gateway must be internal at a predictable name", s)
		replicas := 1
		if s == active {
			replicas = 2
		}
		check(equal(get(ep, "spec", "provider", "kubernetes", "envoyDeployment", "replicas"), replicas), "%s: gateway replicas", s)
		check(str(r.live(s+"-gateway"), "spec", "gatewayClassName") == "basis-ai", "%s: gatewayClassName", s)
		if exposed {
			check(equal(get(r.live(s+"-external-envoyproxy"), "spec", "provider", "kubernetes", "envoyService"),
				M{"name": name + "-external", "type": "LoadBalancer", "loadBalancerSourceRanges": L{"203.0.113.0/24"}}),
				"%s: the external Gateway on a LoadBalancer limited to the source ranges", s)
			cert := r.live(s + "-certificate")
			check(equal(get(cert, "spec", "dnsNames"), L{"llm.example.com"}) && str(cert, "spec", "issuerRef", "name") == "basis" &&
				str(cert, "spec", "secretName") == name+"-tls", "%s: certificate %s", s, repr(get(cert, "spec")))
			listeners := list(r.live(s+"-external-gateway"), "spec", "listeners")
			check(len(listeners) == 1 && str(listeners[0], "protocol") == "HTTPS" && equal(get(listeners[0], "port"), 443),
				"%s: the external Gateway is HTTPS only: %s", s, repr(listeners))
			check(len(list(r.live(s+"-route"), "spec", "parentRefs")) == 2 && len(list(r.live(s+"-securitypolicy"), "spec", "targetRefs")) == 2,
				"%s: route and key auth cover both Gateways", s)
		} else {
			check(r.live(s+"-external-gateway") == nil && r.live(s+"-certificate") == nil, "%s: external Gateway without spec.expose", s)
		}
		// Token metrics for the Project's cost, an access log, the caller upstream.
		pm := r.live(s + "-podmonitor")
		eps := list(pm, "spec", "podMetricsEndpoints")
		check(len(eps) == 2 && equal(get(eps[0], "targetPort"), 1064) && str(eps[1], "port") == "metrics",
			"%s: Agent Router's metrics from the extproc sidecar and Envoy's: %s", s, repr(eps))
		check(str(r.live(s+"-prometheusrule"), "kind") == "PrometheusRule", "%s: latency and error alerts", s)
		check(str(ep, "spec", "telemetry", "accessLog", "settings", 0, "format", "json", "basis") == "gateway", "%s: access log", s)
		check(str(r.live(s+"-securitypolicy"), "spec", "apiKeyAuth", "forwardClientIDHeader") == "x-basis-client", "%s: client header", s)
		rl := r.live(s + "-ratelimit")
		if kase == "minimal" {
			rules := list(rl, "spec", "rateLimit", "global", "rules")
			check(len(rules) == 3 && str(rl, "spec", "targetRefs", 0, "kind") == "HTTPRoute",
				"%s: monthly caps for support-bot and the gateway, and requests per minute: %s", s, repr(rl))
			retry := get(r.live(s+"-backendtraffic"), "spec", "retry")
			check(equal(get(retry, "numAttemptsPerPriority"), 2) && equal(get(retry, "numRetries"), 3),
				"%s: 2 attempts on the model and on its fallback: %s", s, repr(retry))
			for _, rule := range list(r.live(s+"-route"), "spec", "rules") {
				if str(rule, "matches", 0, "headers", 0, "value") == "gpt-4o-mini" {
					refs := list(rule, "backendRefs")
					check(len(refs) == 2 && equal(get(refs[1], "priority"), 1), "%s: llama as gpt-4o-mini's fallback: %s", s, repr(refs))
				}
			}
		} else {
			check(rl == nil, "%s: no rate limits without monthlyTokens", s)
		}
		sp := r.live(s + "-securitypolicy")
		check(equal(get(sp, "spec", "apiKeyAuth", "credentialRefs"), L{M{"name": name + "-keys"}}) &&
			equal(get(sp, "spec", "apiKeyAuth", "sanitize"), true), "%s: client API key auth", s)
		models := map[string]bool{}
		for _, rule := range list(r.live(s+"-route"), "spec", "rules") {
			models[str(list(list(rule, "matches")[0], "headers")[0], "value")] = true
		}
		want := set("gpt-4o-mini", "llama")
		if geo {
			want = set("claude")
		}
		check(sameKeys(models, want), "%s: route models %v", s, sortedKeys(models))
	}
	if geo {
		var policy M
		for key := range composed {
			if strings.HasPrefix(key, "protected-model-") && strings.HasSuffix(key, "-backendsecurity") {
				policy = r.live(key)
			}
		}
		check(str(policy, "spec", "type") == "AnthropicAPIKey", "Anthropic models use AnthropicAPIKey: %s", repr(policy))
	}
	check(len(list(status, "sites")) == len(sites), "status.sites %s", repr(get(status, "sites")))
	wantExternal := ""
	if exposed {
		wantExternal = "https://llm.example.com/v1"
	}
	check(str(status, "externalEndpoint") == wantExternal, "status.externalEndpoint %q", str(status, "externalEndpoint"))
	check(str(r.conds["GatewayReady"], "type") == "GatewayReady", "GatewayReady condition missing")
}
