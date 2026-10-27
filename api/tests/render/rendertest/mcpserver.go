package main

import (
	"encoding/json"
	"strings"
)

func assertMCPServer(r *render) {
	kase, state, status, name, ns, composed := r.kase, r.state, r.status, r.name, r.ns, r.composed
	check := r.check
	geo, cluster := kase == "geo", kase == "cluster"

	sites := []string{"protected"}
	locations := map[string]string{"protected": "si-ske-demo", "recovery": "onprem-ams"}
	if geo {
		sites = append(sites, "recovery")
	}
	active := "protected"
	if geo {
		active = "recovery"
	}
	check(str(status, "endpoint") == "http://"+name+"."+ns+".svc/mcp", "status.endpoint %q", str(status, "endpoint"))
	check(str(status, "activeSite") == active, "status.activeSite %q, want %q", str(status, "activeSite"), active)
	check(len(list(status, "sites")) == len(sites), "status.sites %s", repr(get(status, "sites")))
	check(str(composed["dashboard"], "kind") == "GrafanaDashboard" && str(composed["dashboard"], "spec", "uid") == str(status, "dashboardUid"),
		"dashboard and status.dashboardUid")

	// Keys on the control plane: one per client that hasn't expired.
	keys := mp(composed["keys"], "data")
	wantClients := []string{"agents"}
	if cluster {
		wantClients = []string{"claude-code", "support-bot"}
	}
	check(len(keys) == len(wantClients), "keys for %v: %s", wantClients, repr(sortedKeys(keys)))
	for _, cl := range wantClients {
		check(has(keys, cl), "no key for %s", cl)
	}
	if cluster {
		check(equal(get(status, "expiredClients"), L{"intern"}), "status.expiredClients %s", repr(get(status, "expiredClients")))
	}
	if kase == "minimal" && state == "observed" {
		check(str(keys, "agents") == "a2VwdC1rZXk=", "an existing key must be kept: %s", repr(keys))
	}

	tools := "search,fetch,remember,recall,forget"
	if geo {
		tools = "search,fetch,add_document,delete_document,remember,recall,forget"
	}
	check(strings.Join(strs(get(status, "tools")), ",") == tools, "status.tools %s, want %s", repr(get(status, "tools")), tools)

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
		replicas := 2
		switch {
		case geo && s == active:
			replicas = 3
		case geo:
			replicas = 1
		case cluster:
			replicas = 1
		}
		dep := r.live(s + "-deployment")
		check(str(dep, "kind") == "Deployment" && str(dep, "metadata", "name") == name, "%s: Deployment %s", s, name)
		check(equal(get(dep, "spec", "replicas"), replicas), "%s: replicas %s, want %d", s, repr(get(dep, "spec", "replicas")), replicas)
		pod := mp(dep, "spec", "template", "spec")
		check(equal(get(pod, "securityContext", "runAsNonRoot"), true) && equal(get(pod, "automountServiceAccountToken"), false),
			"%s: restricted pod: %s", s, repr(get(pod, "securityContext")))
		main := get(pod, "containers", 0)
		check(equal(get(main, "securityContext", "readOnlyRootFilesystem"), true), "%s: read-only root", s)
		check(str(main, "readinessProbe", "httpGet", "path") == "/readyz", "%s: ready once it has its database", s)
		check(strings.HasPrefix(str(main, "image"), "ghcr.io/bartvanbenthem/basis-mcp:"), "%s: image %s", s, str(main, "image"))
		env := map[string]M{}
		for _, e := range list(main, "env") {
			env[str(e, "name")] = mp(e)
		}
		if cluster {
			check(str(env["DATABASE_URL"], "value") == "postgresql://docs-rw."+ns+".svc:5432/wiki", "%s: DATABASE_URL %s", s, repr(env["DATABASE_URL"]))
			check(str(env["PGPASSWORD"], "valueFrom", "secretKeyRef", "name") == name+"-database", "%s: the role's password", s)
			check(str(env["OPENAI_BASE_URL"], "value") == "http://shared."+ns+".svc/v1" &&
				str(env["OPENAI_API_KEY"], "valueFrom", "secretKeyRef", "name") == name+"-embeddings", "%s: embeddings env %s", s, repr(env))
			ref := get(composed[s+"-embeddings"], "spec", "references", 0)
			check(str(ref, "patchesFrom", "name") == "shared-keys" && str(ref, "patchesFrom", "fieldPath") == "data.wiki",
				"%s: the server's key copied from the gateway: %s", s, repr(ref))
			check(str(composed[s+"-database"], "spec", "references", 0, "patchesFrom", "name") == "wiki-reader", "%s: the role copied", s)
		} else {
			check(str(main, "envFrom", 0, "secretRef", "name") == "support-connection" && len(env) == 0,
				"%s: the stack's connection Secret: %s", s, repr(main))
			check(composed[s+"-database"] == nil && composed[s+"-embeddings"] == nil, "%s: a stack brings its credentials", s)
		}

		var cfg M
		if err := json.Unmarshal([]byte(str(r.live(s+"-config"), "data", "config.json")), &cfg); err != nil {
			check(false, "%s: config.json: %v", s, err)
			continue
		}
		mode := "text"
		if geo || cluster {
			mode = "hybrid"
		}
		check(str(cfg, "retrieval", "mode") == mode && str(cfg, "site") == s, "%s: config %s", s, repr(cfg))
		if cluster {
			check(str(cfg, "retrieval", "table") == "public.chunks" && equal(get(cfg, "retrieval", "own"), false) &&
				str(cfg, "retrieval", "columns", "embedding") == "vec" && str(cfg, "memory", "scope") == "shared",
				"%s: a table of your own: %s", s, repr(cfg))
			check(equal(get(cfg, "clients", "support-bot", "tools"), L{"search", "fetch", "recall"}) && !has(cfg, "intern", "clients"),
				"%s: clients %s", s, repr(get(cfg, "clients")))
		}

		check(str(r.live(s+"-service"), "spec", "ports", 0, "targetPort") == "http", "%s: Service", s)
		check((r.live(s+"-pdb") != nil) == (replicas > 1), "%s: a PodDisruptionBudget only with more than one replica", s)
		pm := r.live(s + "-podmonitor")
		check(str(pm, "kind") == "PodMonitor" && str(pm, "spec", "selector", "matchLabels", "ai.cndev.nl/mcpserver") == name &&
			str(pm, "spec", "podMetricsEndpoints", 0, "port") == "metrics", "%s: metrics %s", s, repr(get(pm, "spec")))
		rules := list(r.live(s+"-prometheusrule"), "spec", "groups", 0, "rules")
		want := 4
		if geo || cluster {
			want = 5
		}
		check(len(rules) == want, "%s: %d alerts, want %d", s, len(rules), want)
	}

	ready := str(r.conds["MCPServerReady"], "status")
	switch {
	case kase == "minimal" && state == "observed":
		check(ready == "True" && equal(get(status, "ready"), true), "MCPServerReady %s, status %s", ready, repr(status))
	default:
		check(ready == "False", "MCPServerReady %s before the location reports", ready)
	}
}
