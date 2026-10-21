package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/bartvanbenthem/basis-ai/api/internal/doc"
)

func assertValkeyCache(r *render) {
	kase, state, status, name, ns, composed := r.kase, r.state, r.status, r.name, r.ns, r.composed
	check := r.check

	// semantic is pinned (status.location); recovery picks the Project's recovery location.
	location := map[string]string{"minimal": "si-ske-demo", "semantic": "onprem-ams", "recovery": "onprem-ams", "noproject": ""}[kase]
	site := map[bool]string{true: "recovery", false: "protected"}[kase == "recovery"]
	check(str(status, "site") == site, "status.site %q, want %q", str(status, "site"), site)
	want := set("auth-secret", "dashboard")
	if location != "" {
		want = union(want, set("auth", "cluster"))
		if kase != "semantic" { // monitoring off there; the dashboard stays
			want = union(want, set("podmonitor", "prometheusrule"))
		}
	}
	check(sameKeys(composed, want), "composed resources %v, want %v", r.keys(), sortedKeys(want))

	// --- the password Secret on the control plane
	secret := composed["auth-secret"]
	data := mp(secret, "data")
	decoded := map[string]string{}
	for _, k := range []string{"username", "password", "host", "port", "uri"} {
		v, err := base64.StdEncoding.DecodeString(str(data, k))
		check(err == nil && len(v) > 0, "Secret %s: key %s missing or not base64", str(secret, "metadata", "name"), k)
		decoded[k] = string(v)
	}
	check(str(secret, "metadata", "name") == name+"-valkey" && str(secret, "metadata", "namespace") == ns,
		"password Secret must be <name>-valkey in the XR's namespace")
	if state == "observed" {
		check(decoded["password"] == "secret-password-0123456789", "an existing password must be kept, got %q", decoded["password"])
	} else {
		check(len(decoded["password"]) >= 32, "generated password too short: %d characters", len(decoded["password"]))
	}
	host := fmt.Sprintf("valkey-%s.%s.svc", name, ns)
	check(decoded["host"] == host && decoded["port"] == "6379", "host/port %s:%s", decoded["host"], decoded["port"])
	check(decoded["uri"] == fmt.Sprintf("valkey://default:%s@%s:6379", decoded["password"], host), "uri %q", decoded["uri"])

	// --- the dashboard in the project's Grafana, like PostgresCluster's
	dash := composed["dashboard"]
	uid := str(dash, "spec", "uid")
	check(str(dash, "kind") == "GrafanaDashboard" && str(dash, "metadata", "namespace") == ns &&
		str(dash, "metadata", "name") == name+"-valkey", "dashboard: GrafanaDashboard %s-valkey in %s", name, ns)
	check(strings.HasPrefix(uid, "valkey-") && len(uid) == len("valkey-")+20, "dashboard uid %q", uid)
	check(str(status, "monitoring", "dashboardUid") == uid, "status.monitoring.dashboardUid %s, want %s", repr(get(status, "monitoring")), uid)
	check(equal(get(dash, "spec", "instanceSelector"), M{"matchLabels": M{"dashboards.paas.cndev.nl/scope": ns}}),
		"dashboard instanceSelector %s", repr(get(dash, "spec", "instanceSelector")))
	check(str(dash, "spec", "folder") == "Valkey", "dashboard folder %q", str(dash, "spec", "folder"))
	check(equal(get(dash, "spec", "datasources"), L{M{"inputName": "DS_PROMETHEUS", "datasourceName": "prometheus"}}),
		"dashboard datasources %s", repr(get(dash, "spec", "datasources")))
	var body M
	check(json.Unmarshal([]byte(str(dash, "spec", "json")), &body) == nil, "dashboard json doesn't parse")
	check(str(body, "uid") == uid && str(body, "title") == "Valkey / "+ns+" / "+name, "dashboard uid/title %q %q", str(body, "uid"), str(body, "title"))
	check(!strings.Contains(str(dash, "spec", "json"), "zz"), "dashboard placeholders left")
	src, err := doc.Load(filepath.Join(root(), "src", "dashboards", "valkey-cache.json"))
	check(err == nil && len(list(body, "panels")) == len(list(src, "panels")), "dashboard panels differ from src/dashboards/valkey-cache.json")
	for _, v := range list(body, "templating", "list") {
		if n := str(v, "name"); n == "namespace" || n == "cluster" {
			check(str(v, "current", "value") == map[string]string{"namespace": ns, "cluster": name}[n], "dashboard variable %s not preset: %s", n, repr(get(v, "current")))
		}
	}

	if location == "" {
		check(!equal(get(status, "ready"), true), "a cache without a location can't be ready")
		check(strings.Contains(str(status, "message"), "not a Project with a protected location"), "message %q", str(status, "message"))
		check(str(r.conds["CacheReady"], "reason") == "NoLocation", "CacheReady %s", repr(r.conds["CacheReady"]))
		return
	}

	// --- Objects in the location
	for _, k := range sortedKeys(composed) {
		if k == "auth-secret" || k == "dashboard" { // on the control plane
			continue
		}
		obj := composed[k]
		check(str(obj, "kind") == "Object", "%s: must be an Object", k)
		check(str(obj, "metadata", "namespace") == ns && str(obj, "metadata", "name") == name+"-"+k, "%s: name/namespace", k)
		check(equal(get(obj, "spec", "providerConfigRef"), M{"kind": "ClusterProviderConfig", "name": location}),
			"%s: providerConfigRef %s, want location %s", k, repr(get(obj, "spec", "providerConfigRef")), location)
		check(str(r.live(k), "metadata", "namespace") == ns, "%s: must land in the project namespace", k)
	}

	// The copy's data comes from the control plane Secret, never through the Object spec.
	auth := composed["auth"]
	check(!has(r.live("auth"), "data") && !has(r.live("auth"), "stringData"), "the password must not be in the Object spec")
	refs := list(auth, "spec", "references")
	check(len(refs) == 2, "auth: want references for data and type, got %s", repr(refs))
	for _, ref := range refs {
		from := mp(ref, "patchesFrom")
		check(str(from, "name") == name+"-valkey" && str(from, "namespace") == ns, "auth: reference %s", repr(from))
	}

	vc := r.live("cluster")
	spec := mp(vc, "spec")
	check(str(vc, "kind") == "ValkeyCluster" && str(vc, "metadata", "name") == name, "cluster: ValkeyCluster %s", name)
	check(!has(spec, "persistence"), "a cache has no persistence")
	users := list(spec, "users")
	check(len(users) == 1 && str(users[0], "name") == "default" &&
		equal(get(users[0], "passwordSecret"), M{"name": name + "-valkey-auth", "keys": L{"password"}}),
		"the default user must need the generated password: %s", repr(users))
	check(equal(get(users[0], "commands", "deny"), L{"@admin"}), "the app user must not get @admin")

	type expect struct {
		image, maxmemory, policy string
		shards, replicas         int
		exporter                 bool
		args                     L
	}
	e := map[string]expect{
		"minimal":  {image: "valkey/valkey:9.1.2", maxmemory: "768mb", policy: "allkeys-lru", shards: 1, replicas: 1, exporter: true},
		"recovery": {image: "valkey/valkey:9.1.2", maxmemory: "768mb", policy: "allkeys-lru", shards: 1, replicas: 1, exporter: true},
		"semantic": {image: "valkey/valkey-bundle:9.1.2", maxmemory: "1228mb", policy: "allkeys-lfu", shards: 3, replicas: 2,
			args: L{"--loadmodule", "/usr/lib/valkey/libsearch.so --reader-threads 2 --writer-threads 2"}},
		// semantic with monitoring on would add the exporter's --include-modules-metrics (unit tests).
	}[kase]
	check(str(spec, "image") == e.image, "image %s, want %s", str(spec, "image"), e.image)
	check(equal(get(spec, "shards"), e.shards) && equal(get(spec, "replicas"), e.replicas),
		"shards/replicas %v/%v", get(spec, "shards"), get(spec, "replicas"))
	check(equal(get(spec, "config"), M{"maxmemory": e.maxmemory, "maxmemory-policy": e.policy}), "config %s", repr(get(spec, "config")))
	check(equal(get(spec, "exporter", "enabled"), e.exporter), "exporter %s", repr(get(spec, "exporter")))
	if e.args == nil {
		check(!has(spec, "containers"), "an exact cache loads no modules: %s", repr(get(spec, "containers")))
	} else {
		containers := list(spec, "containers")
		check(len(containers) == 1 && str(containers[0], "name") == "server" && equal(get(containers[0], "args"), e.args),
			"semantic: the server must load valkey-search: %s", repr(containers))
	}
	if _, ok := composed["podmonitor"]; ok {
		pm := r.live("podmonitor")
		check(equal(get(pm, "spec", "selector", "matchLabels"), M{"valkey.io/cluster": name}), "podmonitor selector")
		endpoints := list(pm, "spec", "podMetricsEndpoints")
		check(len(endpoints) == 1 && str(endpoints[0], "port") == "metrics", "podmonitor endpoints %s", repr(endpoints))
		// The dashboard and alerts select on these labels.
		targets := map[string]string{}
		for _, rl := range list(endpoints[0], "relabelings") {
			targets[str(rl, "targetLabel")] = strs(get(rl, "sourceLabels"))[0]
		}
		for target, source := range map[string]string{
			"cluster": "__meta_kubernetes_pod_label_valkey_io_cluster",
			"shard":   "__meta_kubernetes_pod_label_valkey_io_shard_index",
			"node":    "__meta_kubernetes_pod_label_valkey_io_node_index"} {
			check(targets[target] == source, "podmonitor relabeling to %s: %q, want %q", target, targets[target], source)
		}
	}
	if _, ok := composed["prometheusrule"]; ok {
		pr := r.live("prometheusrule")
		groups := list(pr, "spec", "groups")
		check(len(groups) == 1 && str(groups[0], "name") == "valkey/"+ns+"/"+name, "prometheusrule groups %s", repr(groups))
		alerts := set()
		for _, rule := range list(groups[0], "rules") {
			alerts[str(rule, "alert")] = true
			expr := str(rule, "expr")
			check(strings.Contains(expr, `namespace="`+ns+`"`) && strings.Contains(expr, `cluster="`+name+`"`),
				"%s: not scoped to the cache: %s", str(rule, "alert"), expr)
			check(str(rule, "labels", "namespace") == ns, "%s: namespace label", str(rule, "alert"))
		}
		check(alerts["ValkeyCacheDown"] && alerts["ValkeyCacheClusterStateNotOk"] && alerts["ValkeyCacheWritesRejected"],
			"prometheusrule alerts %v", sortedKeys(alerts))
		check(!strings.Contains(allStrings(pr), "zz"), "alert placeholders left")
	}

	// --- status
	check(str(status, "location") == location && str(status, "secret") == name+"-valkey" &&
		str(status, "endpoint") == host+":6379", "status location/secret/endpoint %s", repr(status))
	modules := L{}
	if kase == "semantic" {
		modules = L{"search"}
	}
	check(equal(get(status, "modules"), modules), "modules %s", repr(get(status, "modules")))
	ready := kase == "minimal" && state == "observed"
	check(equal(get(status, "ready"), ready), "ready %v, want %v", get(status, "ready"), ready)
	wantCond := "False"
	if ready {
		wantCond = "True"
	}
	check(str(r.conds["Ready"], "status") == wantCond, "XR Ready %s, want %s", repr(r.conds["Ready"]), wantCond)
	check(str(r.conds["CacheReady"], "status") == wantCond, "CacheReady %s", repr(r.conds["CacheReady"]))
	if kase == "semantic" && state == "observed" {
		check(str(r.conds["CacheReady"], "reason") == "ApplyFailed" &&
			strings.Contains(str(status, "message"), "Valkey operator installed"),
			"a missing operator must say so: %s", str(status, "message"))
	}
}
