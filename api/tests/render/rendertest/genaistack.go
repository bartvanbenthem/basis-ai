package main

import (
	"encoding/base64"
	"strings"
)

func assertGenAIStack(r *render) {
	kase, state, status, name, ns, composed := r.kase, r.state, r.status, r.name, r.ns, r.composed
	check := r.check
	geo := kase == "geo"

	sites := []string{"protected"}
	locations := map[string]string{"protected": "si-ske-demo", "recovery": "onprem-ams"}
	if geo {
		sites = append(sites, "recovery")
	}
	// xr/geo.yaml switches over; the stack follows once the database has
	// moved (observed/geo.yaml).
	active := "protected"
	if geo && state == "observed" {
		active = "recovery"
	}
	check(str(status, "activeSite") == active, "activeSite %q, want %q", str(status, "activeSite"), active)

	// --- the child APIs next to the stack
	db := composed["database"]
	check(str(db, "kind") == "PostgresCluster" && str(db, "metadata", "name") == name+"-db" && str(db, "metadata", "namespace") == ns,
		"database: PostgresCluster %s-db", name)
	check(str(db, "spec", "profile") == "vector" && equal(get(db, "spec", "postgresVersion"), 18), "database: vector profile on PostgreSQL 18")
	check(equal(get(db, "spec", "geoReplication", "enabled"), geo) && equal(get(db, "spec", "backup", "enabled"), geo),
		"database: geoReplication and backup %v", geo)
	wantPrimary := "protected"
	if geo {
		wantPrimary = "recovery"
	}
	check(str(db, "spec", "geoReplication", "primarySite") == wantPrimary, "database: primarySite %q, want %q (the stack's activeSite)",
		str(db, "spec", "geoReplication", "primarySite"), wantPrimary)
	roles := list(db, "spec", "roles")
	role := strings.ReplaceAll(name, "-", "_") + "_stack"
	check(len(roles) == 1 && str(roles[0], "name") == role && str(roles[0], "passwordSecret") == name+"-db-credentials" &&
		equal(get(roles[0], "inRoles"), L{"app"}), "database roles %s", repr(roles))
	creds := composed["db-credentials"]
	check(str(creds, "type") == "kubernetes.io/basic-auth", "db-credentials must be basic-auth (CNPG managed roles)")

	caches := map[string]string{"protected": "cache", "recovery": "cache-dr"}
	for _, s := range sites {
		c := composed[caches[s]]
		check(str(c, "kind") == "ValkeyCache" && str(c, "spec", "site") == s, "%s: ValkeyCache on site %s", caches[s], s)
		check(equal(get(c, "spec", "shards"), 1) && equal(get(c, "spec", "replicas"), 0), "%s: one node, so plain clients work", caches[s])
		want := "512Mi"
		if s == active {
			want = "1Gi"
		}
		check(str(c, "spec", "resources", "memory") == want, "%s: memory %q, want %q (active %s)",
			caches[s], str(c, "spec", "resources", "memory"), want, active)
	}

	// --- the stack's own gateway, a ModelGateway following the active site
	gw := composed["gateway"]
	check(str(gw, "kind") == "ModelGateway" && str(gw, "metadata", "name") == name+"-gateway", "gateway: ModelGateway %s-gateway", name)
	check(str(gw, "spec", "activeSite") == active && equal(get(gw, "spec", "recovery", "enabled"), geo),
		"gateway: activeSite %q recovery %v", str(gw, "spec", "activeSite"), get(gw, "spec", "recovery", "enabled"))
	check(equal(get(gw, "spec", "clients"), L{M{"name": "apps"}}), "gateway: the stack's client")
	wantModels := 2
	if geo {
		wantModels = 1
	}
	check(len(list(gw, "spec", "models")) == wantModels, "gateway: models %s", repr(get(gw, "spec", "models")))

	// --- what the stack composes is the stack's (the ownership policy reads this label)
	for _, key := range []string{"database", "cache", "gateway"} {
		check(str(composed[key], "metadata", "labels", "ai.cndev.nl/genaistack") == name, "%s: owner label", key)
	}

	// --- per site: wiring in the location
	for _, s := range sites {
		conn := composed["connection-"+s]
		data := map[string]string{}
		for k, v := range mp(conn, "data") {
			raw, _ := base64.StdEncoding.DecodeString(v.(string))
			data[k] = string(raw)
		}
		cacheHost := "valkey-" + name + "-cache"
		if s == "recovery" {
			cacheHost += "-dr"
		}
		check(data["SITE"] == s && data["ACTIVE"] == map[bool]string{true: "true", false: "false"}[s == active], "connection-%s: SITE/ACTIVE %v", s, data)
		check(strings.HasPrefix(data["DATABASE_URL"], "postgresql://"+role+":") &&
			strings.HasSuffix(data["DATABASE_URL"], "@"+name+"-db-rw."+ns+".svc:5432/app"), "connection-%s: DATABASE_URL %q", s, data["DATABASE_URL"])
		check(strings.Contains(data["VALKEY_URL"], "@"+cacheHost+"."+ns+".svc:6379") && data["VALKEY_CLUSTER"] == "false",
			"connection-%s: VALKEY_URL %q", s, data["VALKEY_URL"])
		check(data["OPENAI_BASE_URL"] == "http://"+name+"-gateway."+ns+".svc/v1" && data["OPENAI_API_KEY"] == "gateway-key",
			"connection-%s: gateway %v", s, data)
		if state == "observed" {
			check(data["DATABASE_PASSWORD"] == "db-password", "connection-%s: generated credentials must be kept", s)
		}

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
		check(r.live(s+"-connection") != nil, "%s: the connection Secret in the location", s)
	}

	check(len(list(status, "sites")) == len(sites), "status.sites %s", repr(get(status, "sites")))
	check(str(status, "connectionSecret") == name+"-connection", "status.connectionSecret")
	check(str(r.conds["StackReady"], "type") == "StackReady", "StackReady condition missing")
}
