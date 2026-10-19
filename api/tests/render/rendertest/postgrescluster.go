package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
)

// One location's worth of objects with backups on, and the recovery site's
// copy (prefix recovery-). Every member copies the S3 Secret to its location.
var (
	pgMember     = set("cluster", "objectstore", "scheduled-backup", "podmonitor", "monitoring-queries", "prometheusrule", "secret-orders-db-s3")
	pgReplicated = union(pgMember, set("dashboard"), prefixed("recovery-", pgMember))
	pgBucketSite = set("cluster", "objectstore", "scheduled-backup", "podmonitor", "monitoring-queries", "prometheusrule")
)

var pgExpected = map[string]map[string]bool{
	"bare":      set("cluster"),
	"minimal":   set("cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard"),
	"pinned":    set("cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard"),
	"noproject": set("dashboard"),
	"production": set("cluster", "objectstore", "scheduled-backup", "database-payments-audit",
		"pooler-rw", "pooler-ro", "podmonitor", "monitoring-queries", "podmonitor-pooler",
		"prometheusrule", "dashboard", "secret-payments-db-s3", "secret-payments-db-reporting"),
	"secrets": set("cluster", "objectstore", "scheduled-backup", "podmonitor", "monitoring-queries", "prometheusrule",
		"pooler-rw", "podmonitor-pooler", "dashboard",
		"secret-ledger-db-s3", "secret-ledger-db-reporting"),
	"replicated": pgReplicated,
	"switchover": pgReplicated,
	"failover":   pgReplicated,
	"promoted":   pgReplicated,
	"draining":   pgReplicated,
	// The Project's COSI bucket: the same set per site, with its own credentials copy.
	"projectbucket": union(pgBucketSite, set("secret-secrets-db-backup-s3", "dashboard"),
		prefixed("recovery-", union(pgBucketSite, set("secret-secrets-db-backup-s3")))),
	"bucketpending": set("dashboard"),
	// Restored from the Project's bucket: the projectbucket set plus the
	// read-only restore store in the protected site.
	"restored": union(pgBucketSite, set("secret-secrets-db-r-backup-s3", "dashboard", "restore-objectstore"),
		prefixed("recovery-", union(pgBucketSite, set("secret-secrets-db-r-backup-s3")))),
	// From a store of its own, without backups: no archive, only the restore store and its credentials.
	"restorecustom":  set("cluster", "restore-objectstore", "secret-ledger-db-s3", "podmonitor", "monitoring-queries", "prometheusrule"),
	"restorepending": set("dashboard"),
	"sized":          set("cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard"),
	"sizegone":       set("cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard"),
	"sizechanged":    set("cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard"),
	// An unknown size: nothing placed until it names one in the catalog.
	"sizeunknown": set("dashboard"),
	// The bootstrap database's extensions get a Database of their own.
	"extensions": set("cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard", "database-docs", "database-analytics"),
	// ... unless databases[] lists that database.
	"extensionslisted": set("cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard", "database-app"),
	"vector":           set("cluster", "podmonitor", "monitoring-queries", "prometheusrule", "dashboard", "database-docs"),
}

// The postgresql.conf settings the extensions in use bring from the
// postgres-extensions catalog, under the size's and spec's.
var pgExtensionParams = map[string]M{
	"extensions": {"pg_stat_statements.track": "top"},
	"production": {"pg_stat_statements.track": "top"},
}

const (
	pgRecovery = "onprem-ams"
	pgToken    = "eyJsc24iOiIwLzMwMDAwMDAifQ=="
	// The recovery site's lastPromotionToken from an earlier promotion (observed/switchover.yaml).
	pgPrevToken = "eyJsc24iOiIwLzIwMDAwMDAifQ=="
)

// sizing: (size, resources, parameters, profile) per case.
type sizing struct {
	size              string
	resources, params M
	profile           string
}

var defaultResources = M{"requests": M{"cpu": "500m", "memory": "1Gi"}, "limits": M{"memory": "1Gi"}}

// spec.size from the postgres-sizes catalog (its resources and settings,
// spec.postgresql.parameters on top), else spec.resources or the defaults;
// status.sizing says what every site runs with.
var pgSizing = map[string]sizing{
	"sized": {"m", M{"requests": M{"cpu": "2", "memory": "8Gi"}, "limits": M{"memory": "8Gi"}},
		M{"shared_buffers": "2GB", "effective_cache_size": "6GB", "work_mem": "16MB",
			"maintenance_work_mem": "512MB", "max_connections": "200"}, ""},
	// Kept from status.sizing: the catalog no longer has "retired".
	"sizegone": {"retired", M{"requests": M{"cpu": "3", "memory": "12Gi"}, "limits": M{"memory": "12Gi"}},
		M{"shared_buffers": "3GB"}, ""},
	// Not applied: the instances keep the size they had.
	"sizechanged": {"m", M{"requests": M{"cpu": "2", "memory": "8Gi"}, "limits": M{"memory": "8Gi"}},
		M{"shared_buffers": "2GB"}, ""},
	"production": {"", M{"requests": M{"cpu": "1", "memory": "4Gi"}, "limits": M{"memory": "4Gi"}}, M{}, ""},
	// Size m with its vector settings over its own.
	"vector": {"m", M{"requests": M{"cpu": "2", "memory": "8Gi"}, "limits": M{"memory": "8Gi"}},
		M{"shared_buffers": "2GB", "effective_cache_size": "6GB", "work_mem": "16MB",
			"maintenance_work_mem": "1536MB", "max_parallel_maintenance_workers": "2", "max_connections": "200"}, "vector"},
}

func assertPostgresCluster(r *render, dashboardSrc string) {
	kase, state, status, conds, name, ns, xr := r.kase, r.state, r.status, r.conds, r.name, r.ns, r.xr
	check := r.check

	expected, ok := pgExpected[kase]
	if !ok {
		check(false, "no expectations for case %s", kase)
		return
	}
	check(sameKeys(r.composed, expected), "composed resources %v != expected %v", r.keys(), sortedKeys(expected))

	// --- sites: the protected location from the Project (or status.sites), the
	// recovery location for the recovery- objects. Nothing but the dashboard runs
	// on the control plane.
	protected := "si-ske-demo"
	if kase == "pinned" {
		protected = "onprem-rtm"
	}
	geo := slices.Contains([]string{"replicated", "switchover", "failover", "promoted", "draining"}, kase)
	for _, key := range r.keys() {
		obj := r.composed[key]
		if key == "dashboard" {
			check(str(obj, "kind") == "GrafanaDashboard", "the dashboard is composed directly (Grafana runs on the control plane)")
			continue
		}
		loc := protected
		if strings.HasPrefix(key, "recovery-") {
			loc = pgRecovery
		}
		check(str(obj, "kind") == "Object", "%s: objects for location %s must be wrapped in an Object", key, loc)
		if str(obj, "kind") != "Object" {
			continue
		}
		check(equal(get(obj, "spec", "providerConfigRef"), M{"kind": "ClusterProviderConfig", "name": loc}),
			"%s: providerConfigRef %s", key, repr(get(obj, "spec", "providerConfigRef")))
		check(str(obj, "metadata", "annotations", "platform.cndev.nl/location") == loc, "%s: location annotation", key)
		manifest := mp(obj, "spec", "forProvider", "manifest")
		var leaked []string
		for _, a := range sortedKeys(mp(manifest, "metadata", "annotations")) {
			if strings.Contains(a, "crossplane") || strings.HasPrefix(a, "platform.cndev.nl/") {
				leaked = append(leaked, a)
			}
		}
		check(len(leaked) == 0, "%s: composition annotations leaked into the manifest: %v", key, leaked)
		check(str(manifest, "metadata", "namespace") == ns, "%s: manifest not in namespace %s", key, ns)
		if str(manifest, "kind") == "Secret" {
			// Copied by reference: the value must never be in the Object spec.
			check(!has(manifest, "data") && !has(manifest, "stringData"), "%s: Secret data in the Object spec", key)
			var refs L
			var paths []string
			for _, ref := range list(obj, "spec", "references") {
				refs = append(refs, get(ref, "patchesFrom"))
				paths = append(paths, str(ref, "patchesFrom", "fieldPath"))
			}
			slices.Sort(paths)
			check(slices.Equal(paths, []string{"data", "type"}), "%s: Secret must be patched by reference: %s", key, repr(refs))
			// The Project bucket's credentials come from backup-s3-<location> (checked below); the rest from the same name here.
			if !strings.HasSuffix(key, "-backup-s3") {
				all := true
				for _, ref := range refs {
					all = all && str(ref, "kind") == "Secret" && str(ref, "name") == str(manifest, "metadata", "name") &&
						str(ref, "namespace") == ns
				}
				check(all, "%s: Secret must be patched from %s/%s: %s", key, ns, str(manifest, "metadata", "name"), repr(refs))
			}
		}
	}

	switch kase {
	case "noproject":
		check(equal(get(status, "locations"), L{}) && !has(status, "sites") && !has(status, "primaryLocation"),
			"no sites without a Project: %s", repr(status))
		check(strings.Contains(str(status, "message"), "not a Project with a protected location"), "message %s", repr(get(status, "message")))
		check(str(conds["PostgresReady"], "reason") == "NoSite", "PostgresReady reason NoSite")
	case "sizeunknown":
		check(equal(get(status, "locations"), L{}) && !has(status, "sizing"), "nothing placed yet: %s", repr(status))
		check(strings.Contains(str(status, "message"), "size huge is not in the postgres-sizes catalog"), "message %s", repr(get(status, "message")))
	case "bucketpending", "restorepending":
		check(equal(get(status, "locations"), L{}) && !has(status, "backupStore"), "nothing placed yet: %s", repr(status))
		verb := "backup uses"
		if kase == "restorepending" {
			verb = "restore reads from"
		}
		check(strings.Contains(str(status, "message"), verb+" the backup bucket of Project vault, which isn't ready"),
			"message %s", repr(get(status, "message")))
	default:
		// The Projects in payments (required/default.yaml) and vault (projectbucket) have a recovery site.
		wantSites := M{"protected": protected}
		if ns == "payments" || kase == "projectbucket" || kase == "restored" {
			wantSites["recovery"] = pgRecovery
		}
		check(equal(get(status, "sites"), wantSites), "status.sites %s != %s", repr(get(status, "sites")), repr(wantSites))
	}

	// --- backups in the Project's COSI bucket: one bucket, credentials per site from the Project's Secrets
	if kase == "projectbucket" || kase == "restored" {
		store := M{"destinationPath": "s3://vault-backups-0f3a/barman", "endpointURL": "https://s3.example.com",
			"namespace": "vault", "region": true}
		check(equal(get(status, "backupStore"), store), "status.backupStore %s", repr(get(status, "backupStore")))
		for _, site := range [][2]string{{"", protected}, {"recovery-", pgRecovery}} {
			prefix, loc := site[0], site[1]
			cfg := mp(r.live(prefix+"objectstore"), "spec", "configuration")
			check(str(cfg, "destinationPath") == store["destinationPath"] && str(cfg, "endpointURL") == store["endpointURL"],
				"%s: ObjectStore not in the project bucket: %s", loc, repr(cfg))
			creds := mp(cfg, "s3Credentials")
			sameSecret := true
			for _, k := range []string{"accessKeyId", "secretAccessKey", "region"} {
				sameSecret = sameSecret && str(creds, k, "name") == name+"-backup-s3"
			}
			check(sameSecret && str(creds, "accessKeyId", "key") == "ACCESS_KEY_ID" &&
				str(creds, "secretAccessKey", "key") == "ACCESS_SECRET_KEY" && str(creds, "region", "key") == "REGION",
				"%s: s3Credentials %s", loc, repr(creds))
			secret := r.composed[fmt.Sprintf("%ssecret-%s-backup-s3", prefix, name)]
			var refs L
			all := true
			for _, ref := range list(secret, "spec", "references") {
				p := get(ref, "patchesFrom")
				refs = append(refs, p)
				all = all && str(p, "namespace") == "vault" && str(p, "name") == "backup-s3-"+loc
			}
			check(all, "%s: credentials must come from vault/backup-s3-%s: %s", loc, loc, repr(refs))
		}
		if kase == "projectbucket" {
			check(str(r.live("objectstore"), "spec", "retentionPolicy") == "14d", "the cluster's own backup settings stay")
			ext := map[string]bool{}
			for _, e := range list(r.live("recovery-cluster"), "spec", "externalClusters") {
				ext[str(e, "name")] = true
			}
			check(sameKeys(ext, set("secrets-db", "secrets-db-onprem-ams")), "externalClusters %v", sortedKeys(ext))
		}
	} else {
		check(!has(status, "backupStore"), "backupStore only for clusters on the Project's bucket")
	}

	// --- distributed topology
	if geo {
		main, replica := mp(r.live("cluster"), "spec"), mp(r.live("recovery-cluster"), "spec")
		for _, spec := range []M{main, replica} {
			ext := M{}
			for _, e := range list(spec, "externalClusters") {
				ext[str(e, "name")] = get(e, "plugin", "parameters")
			}
			ok := sameKeys(ext, set("orders-db", "orders-db-onprem-ams"))
			for n, p := range ext {
				ok = ok && str(p, "serverName") == n && str(p, "barmanObjectName") == "orders-db-backup"
			}
			check(ok, "externalClusters %s", repr(ext))
		}
		check(str(main, "replica", "self") == "orders-db" && str(replica, "replica", "self") == "orders-db-onprem-ams",
			"replica.self must be the member's topology name")
		check(has(main, "initdb", "bootstrap") && equal(get(replica, "bootstrap"), M{"recovery": M{"source": "orders-db"}}),
			"the protected site runs initdb, the replica cluster recovers from it")
		check(!has(main, "serverName", "plugins", 0, "parameters"), "the protected site keeps its archive folder")
		check(str(replica, "plugins", 0, "parameters", "serverName") == "orders-db-onprem-ams",
			"the replica cluster archives to its own folder")
		check(str(r.live("recovery-cluster"), "metadata", "name") == "orders-db",
			"every member's Cluster is named after the XR (stable service/secret names)")
		if kase == "replicated" {
			check(equal(get(replica, "instances"), 2), "geoReplication.instances")
		}
		// Who is primary, per case and state: (main.primary, replica.primary, token on the promoted member, status)
		want := map[string]L{
			"replicated":          {"orders-db", "orders-db", nil, protected},
			"switchover/empty":    {"orders-db-onprem-ams", "orders-db", nil, protected},
			"switchover/observed": {"orders-db-onprem-ams", "orders-db-onprem-ams", pgToken, pgRecovery},
			"failover":            {"orders-db-onprem-ams", "orders-db-onprem-ams", nil, pgRecovery},
			"promoted":            {"orders-db-onprem-ams", "orders-db-onprem-ams", pgToken, pgRecovery},
			// Draining: switching back to the protected site, waiting for onprem-ams' demotion token.
			"draining": {"orders-db-onprem-ams", "orders-db", nil, pgRecovery},
		}
		exp, ok := want[kase+"/"+state]
		if !ok {
			exp = want[kase]
		}
		got := L{get(main, "replica", "primary"), get(replica, "replica", "primary"),
			get(replica, "replica", "promotionToken"), get(status, "primaryLocation")}
		check(equal(got, exp), "(protected primary, recovery primary, token, status.primaryLocation) %s != %s", repr(got), repr(exp))
		check(!has(main, "promotionToken", "replica"), "the protected site was never promoted here")
		if kase != "draining" {
			check(equal(get(status, "promotionToken"), exp[2]), "status.promotionToken %s", repr(get(status, "promotionToken")))
		}
		primarySite := "protected"
		if exp[3] == pgRecovery {
			primarySite = "recovery"
		}
		check(str(status, "primarySite") == primarySite, "status.primarySite %s", repr(get(status, "primarySite")))
		sites, roles := M{}, M{}
		for _, l := range list(status, "locations") {
			sites[str(l, "location")] = get(l, "site")
			roles[str(l, "location")] = get(l, "role")
		}
		check(equal(sites, M{protected: "protected", pgRecovery: "recovery"}), "sites %s", repr(sites))
		switch {
		case kase+"/"+state == "switchover/empty":
			check(equal(roles, M{protected: "primary", pgRecovery: "promoting"}), "roles %s", repr(roles))
			check(strings.Contains(str(status, "message"), "waiting for the demotion token"), "message %s", repr(get(status, "message")))
		case kase == "draining":
			check(equal(roles, M{protected: "promoting", pgRecovery: "primary"}), "roles %s", repr(roles))
		default:
			primary := exp[3].(string)
			other := protected
			if primary == protected {
				other = pgRecovery
			}
			check(equal(roles, M{primary: "primary", other: "replica"}), "roles %s", repr(roles))
		}
		// CNPG reload workaround: a member that recorded a promotion carries a
		// placeholder GUC derived from it, so its instances reload their config.
		marker := L{nil, nil}
		if kase+"/"+state == "switchover/observed" {
			sum := sha256.Sum256([]byte(pgPrevToken))
			marker = L{nil, hex.EncodeToString(sum[:])[:16]}
		}
		got = L{get(main, "postgresql", "parameters", "tuskpilot.last_promotion"),
			get(replica, "postgresql", "parameters", "tuskpilot.last_promotion")}
		check(equal(got, marker), "tuskpilot.last_promotion %s", repr(got))
	} else if !slices.Contains([]string{"noproject", "bucketpending", "projectbucket", "restored", "restorepending", "sizeunknown"}, kase) {
		spec := mp(r.live("cluster"), "spec")
		var ext []string
		for _, e := range list(spec, "externalClusters") {
			ext = append(ext, str(e, "name"))
		}
		var wantExt []string
		if has(xr, "restore", "spec") {
			wantExt = []string{"restore-source"}
		}
		check(!has(spec, "replica") && slices.Equal(ext, wantExt),
			"a single-site cluster has no replica topology: externalClusters %v", ext)
		check(str(status, "primaryLocation") == protected, "status.primaryLocation %s", repr(get(status, "primaryLocation")))
		check(str(status, "primarySite") == "protected", "status.primarySite %s", repr(get(status, "primarySite")))
		var locs L
		for _, l := range list(status, "locations") {
			locs = append(locs, L{get(l, "location"), get(l, "site")})
		}
		check(equal(locs, L{L{protected, "protected"}}), "status.locations")
	}

	for _, key := range r.keys() {
		obj := r.composed[key]
		check(str(obj, "metadata", "namespace") == ns, "%s: not in XR namespace %s", key, ns)
		check(str(obj, "metadata", "labels", "cnpg.cndev.nl/postgrescluster") == name,
			"%s: missing cnpg.cndev.nl/postgrescluster label", key)
	}

	// --- readiness / status
	if state == "empty" || slices.Contains([]string{"noproject", "bucketpending", "restorepending", "sizeunknown", "sizechanged"}, kase) {
		check(equal(get(status, "ready"), false), "status.ready should be false before the Cluster exists")
		check(str(conds["PostgresReady"], "status") == "False", "PostgresReady should be False")
		if kase != "sizechanged" { // its composed resources are all there
			check(str(conds["Ready"], "status") == "False", "XR Ready should be False")
		}
	} else {
		check(equal(get(status, "ready"), true), "status.ready should be true, got %s", repr(get(status, "ready")))
		wantReady := get(r.live("cluster"), "spec", "instances")
		check(equal(get(status, "readyInstances"), wantReady), "readyInstances should be %s", repr(wantReady))
		check(str(status, "currentPrimary") == name+"-1", "currentPrimary not mirrored")
		check(str(conds["PostgresReady"], "status") == "True", "PostgresReady should be True")
		check(str(conds["Ready"], "status") == "True", "XR Ready should be True, got %s", repr(conds["Ready"]))
		if kase == "production" {
			check(str(status, "backup", "lastSuccessfulBackup") == "2026-10-07T02:00:41Z",
				"backup.lastSuccessfulBackup not mirrored from ObjectStore")
		}
	}

	// --- sizing
	if kase != "sizeunknown" {
		sz, ok := pgSizing[kase]
		if !ok {
			sz = sizing{"", defaultResources, M{}, ""}
		}
		want := M{"size": sz.size, "resources": sz.resources, "parameters": sz.params}
		if sz.profile != "" {
			want["profile"] = sz.profile
		}
		check(equal(get(status, "sizing"), want), "status.sizing %s != %s", repr(get(status, "sizing")), repr(want))
		for _, key := range []string{"cluster", "recovery-cluster"} {
			if _, ok := r.composed[key]; !ok {
				continue
			}
			spec := mp(r.live(key), "spec")
			check(equal(get(spec, "resources"), sz.resources), "%s: resources %s != %s", key, repr(get(spec, "resources")), repr(sz.resources))
			// tuskpilot.last_promotion is the CNPG reload workaround, checked with the topology.
			got := M{}
			for k, v := range mp(spec, "postgresql", "parameters") {
				if k != "tuskpilot.last_promotion" {
					got[k] = v
				}
			}
			user := mp(xr, "spec", "postgresql", "parameters")
			merged := M{}
			for k, v := range pgExtensionParams[kase] {
				merged[k] = v
			}
			for k, v := range sz.params {
				merged[k] = v
			}
			for k, v := range user {
				merged[k] = v
			}
			check(equal(got, merged), "%s: parameters %s != extensions' under size's under spec's %s", key, repr(got), repr(merged))
		}
	}
	// --- extensions: one CNPG Database per database, the bootstrap one never dropped.
	wantDBs := map[string]M{
		"extensions": {
			"database-docs":      M{"name": "docs", "owner": "docs", "reclaim": "retain", "extensions": L{"vector", "pg_trgm"}},
			"database-analytics": M{"name": "analytics", "owner": "docs", "reclaim": "retain", "extensions": L{"pg_stat_statements"}},
		},
		"extensionslisted": {
			"database-app": M{"name": "app", "owner": "app", "reclaim": "retain", "extensions": L{"pg_trgm"}},
		},
		// What they require (vector) first, although the spec leaves it out.
		"vector": {
			"database-docs": M{"name": "docs", "owner": "docs", "reclaim": "retain", "extensions": L{"vector", "vchord", "pg_search"}},
		},
	}[kase]
	for key, want := range wantDBs {
		spec := mp(r.live(key), "spec")
		var exts L
		for _, e := range list(spec, "extensions") {
			check(str(e, "ensure") == "present", "%s: extension %s not ensured present", key, str(e, "name"))
			exts = append(exts, str(e, "name"))
		}
		got := M{"name": str(spec, "name"), "owner": str(spec, "owner"), "reclaim": str(spec, "databaseReclaimPolicy"), "extensions": exts}
		check(equal(got, want), "%s: %s != %s", key, repr(got), repr(want))
		check(str(spec, "cluster", "name") == name, "%s: cluster.name", key)
	}

	// --- image extensions: mounted from the catalog's images and preloaded.
	if kase == "vector" {
		pg := mp(r.live("cluster"), "spec", "postgresql")
		var mounted L
		for _, e := range list(pg, "extensions") {
			mounted = append(mounted, str(e, "name"))
			check(strings.Contains(str(e, "image", "reference"), "@sha256:"), "extension %s image not pinned by digest", str(e, "name"))
		}
		check(equal(mounted, L{"vchord", "pg_search"}), "image extensions %s", repr(mounted))
		check(equal(get(pg, "shared_preload_libraries"), L{"vchord", "pg_search"}), "shared_preload_libraries %s", repr(get(pg, "shared_preload_libraries")))
		check(equal(get(r.live("cluster"), "spec", "imageCatalogRef", "major"), float64(18)), "imageCatalogRef.major should be 18")
		queries := str(r.live("monitoring-queries"), "data", "queries")
		check(strings.Contains(queries, "vector_index:") && strings.Contains(queries, "create_index_progress:"), "vector exporter queries missing")
	}

	if kase == "sizechanged" {
		check(strings.Contains(str(status, "message"), "size huge is not in the postgres-sizes catalog; the instances keep running as m"),
			"message %s", repr(get(status, "message")))
	}
	if kase == "sizegone" {
		check(!strings.Contains(str(status, "message"), "catalog"), "a retired size is no problem: %s", repr(get(status, "message")))
	}

	// --- backup folders: the cluster's name, a folder of its own per replica cluster.
	// The Project keeps an inventory of them through the label on the ObjectStore's Object.
	for _, key := range r.keys() {
		switch {
		case strings.HasSuffix(key, "objectstore") && !strings.HasSuffix(key, "restore-objectstore"):
			manifest := r.live(key)
			folder := get(manifest, "metadata", "annotations", "cnpg.cndev.nl/server-name")
			params := mp(r.live(strings.Replace(key, "objectstore", "cluster", 1)), "spec", "plugins", 0, "parameters")
			archived := get(params, "serverName")
			if archived == nil {
				archived = name
			}
			check(equal(folder, archived), "%s: server-name annotation %s != the folder archived to", key, repr(folder))
			check(str(r.composed[key], "metadata", "labels", "cnpg.cndev.nl/backup-store") == "true",
				"%s: the Project finds backup folders by the cnpg.cndev.nl/backup-store label", key)
			version := "17"
			if v := get(xr, "spec", "postgresVersion"); v != nil {
				version = fmt.Sprint(v)
			}
			check(str(manifest, "metadata", "annotations", "cnpg.cndev.nl/postgres-version") == version,
				"%s: postgres-version annotation", key)
		case strings.Contains(key, "objectstore"):
			check(!has(r.composed[key], "cnpg.cndev.nl/backup-store", "metadata", "labels"),
				"%s: a restore source is not one of this cluster's backup folders", key)
		}
	}
	if _, ok := r.composed["objectstore"]; ok && len(list(status, "locations")) > 0 {
		var primary string
		for _, l := range list(status, "locations") {
			if str(l, "role") == "primary" {
				primary = str(l, "location")
				break
			}
		}
		key := "recovery-objectstore"
		if primary == protected {
			key = "objectstore"
		}
		check(equal(get(status, "backup", "serverName"), get(r.live(key), "metadata", "annotations", "cnpg.cndev.nl/server-name")),
			"status.backup.serverName %s is the primary's folder", repr(get(status, "backup")))
	}

	// --- restore: the protected site bootstraps from the source folder through a
	// read-only store, and archives to a folder of its own.
	if kase == "restored" || kase == "restorecustom" {
		restore := mp(xr, "spec", "restore")
		uid := str(xr, "metadata", "uid")
		own := fmt.Sprintf("%s-%s", name, uid[:min(8, len(uid))])
		spec := mp(r.live("cluster"), "spec")
		database, owner := "app", "app"
		if v := str(xr, "spec", "database", "name"); has(xr, "name", "spec", "database") {
			database = v
		}
		if v := str(xr, "spec", "database", "owner"); has(xr, "owner", "spec", "database") {
			owner = v
		}
		want := M{"source": "restore-source", "database": database, "owner": owner}
		if has(restore, "targetTime") {
			want["recoveryTarget"] = M{"targetTime": get(restore, "targetTime")}
		}
		check(equal(get(spec, "bootstrap"), M{"recovery": want}), "bootstrap %s != %s", repr(get(spec, "bootstrap")), repr(want))
		ext := M{}
		for _, e := range list(spec, "externalClusters") {
			ext[str(e, "name")] = get(e, "plugin", "parameters")
		}
		check(equal(ext["restore-source"], M{"barmanObjectName": name + "-restore", "serverName": get(restore, "source", "serverName")}),
			"restore-source externalCluster %s", repr(ext["restore-source"]))
		store := mp(r.live("restore-objectstore"), "spec")
		check(!has(store, "retentionPolicy"), "the restore store must never prune the source's backups")
		if kase == "restored" {
			check(str(status, "backup", "serverName") == own, "status.backup.serverName %s != %s", repr(get(status, "backup")), own)
			check(str(spec, "plugins", 0, "parameters", "serverName") == own, "a restored cluster archives to a folder of its own")
			check(sameKeys(ext, set(own, own+"-"+pgRecovery, "restore-source")), "externalClusters %v", sortedKeys(ext))
			check(str(spec, "replica", "self") == own && own == str(spec, "replica", "primary"), "replica %s", repr(get(spec, "replica")))
			replica := mp(r.live("recovery-cluster"), "spec")
			check(equal(get(replica, "bootstrap"), M{"recovery": M{"source": own}}),
				"the replica cluster starts from %s: %s", own, repr(get(replica, "bootstrap")))
			check(str(replica, "plugins", 0, "parameters", "serverName") == own+"-"+pgRecovery, "replica cluster folder")
			_, restoresTwice := r.composed["recovery-restore-objectstore"]
			check(!restoresTwice, "only the protected site restores")
			check(str(store, "configuration", "destinationPath") == "s3://vault-backups-0f3a/barman" &&
				str(store, "configuration", "s3Credentials", "accessKeyId", "name") == name+"-backup-s3",
				"restore store not on the Project's bucket: %s", repr(store))
			if state == "empty" {
				check(strings.HasPrefix(str(status, "message"),
					fmt.Sprintf("Restoring %s from backup folder secrets-db (up to 2026-10-08T09:30:00Z)", name)),
					"message %s", repr(get(status, "message")))
			}
		} else {
			check(!has(spec, "plugins") && !has(spec, "replica"), "no backups, no topology: nothing to archive")
			check(sameKeys(ext, set("restore-source")), "externalClusters %v", sortedKeys(ext))
			cfg := mp(store, "configuration")
			check(equal(get(cfg, "destinationPath"), get(restore, "source", "destinationPath")) &&
				equal(get(cfg, "endpointURL"), get(restore, "source", "endpointURL")) &&
				equal(get(cfg, "s3Credentials", "secretAccessKey"), M{"name": "ledger-db-s3", "key": "ACCESS_SECRET_KEY"}),
				"restore store %s", repr(cfg))
			check(!has(status, "backupStore") && !has(status, "backup"), "no backups: %s", repr(status))
			if state == "empty" {
				check(strings.Contains(str(status, "message"), "from backup folder ledger-db (latest state)"), "message %s", repr(get(status, "message")))
			}
		}
	}

	check(str(status, "endpoints", "readWrite") == fmt.Sprintf("%s-rw.%s.svc", name, ns), "endpoints.readWrite")
	check(str(status, "secrets", "app") == name+"-app", "secrets.app")

	if kase == "bare" {
		spec := mp(r.live("cluster"), "spec")
		check(!has(spec, "postgresql"), "empty postgresql block must be omitted")
		check(!has(spec, "topologySpreadConstraints"), "zoneSpread: false must drop the zone constraint")
		check(equal(get(spec, "enableSuperuserAccess"), true), "enableSuperuserAccess not passed through")
		check(str(status, "secrets", "superuser") == name+"-superuser", "secrets.superuser")
		check(!has(status, "monitoring"), "no dashboard uid without a dashboard")
	}

	// --- dashboard
	if dash, ok := r.composed["dashboard"]; ok {
		assertDashboard(r, dash, dashboardSrc)
	}

	// --- custom exporter queries: the Cluster reads them from the ConfigMap next to it
	if _, ok := r.composed["monitoring-queries"]; ok {
		cm := r.live("monitoring-queries")
		ref := list(r.live("cluster"), "spec", "monitoring", "customQueriesConfigMap")
		check(len(ref) == 1 && str(ref[0], "name") == str(cm, "metadata", "name") && str(ref[0], "key") == "queries",
			"Cluster spec.monitoring.customQueriesConfigMap should name ConfigMap %s, got %s", str(cm, "metadata", "name"), repr(ref))
		check(strings.Contains(str(cm, "data", "queries"), "wal_archive:"), "monitoring ConfigMap without the wal_archive query")
	}

	// --- alerts
	if _, ok := r.composed["prometheusrule"]; ok {
		rules := list(r.live("prometheusrule"), "spec", "groups", 0, "rules")
		var alerts []string
		for _, rule := range rules {
			check(str(rule, "alert") != "", "alert rule without a name: %s", repr(rule))
			alerts = append(alerts, str(rule, "alert"))
		}
		excluded := strs(get(xr, "spec", "monitoring", "prometheusRule", "excludeRules"))
		check(len(alerts) == 21-len(excluded), "expected %d alert rules, got %d", 21-len(excluded), len(alerts))
		var still []string
		for _, a := range alerts {
			if slices.Contains(excluded, a) {
				still = append(still, a)
			}
		}
		check(len(still) == 0, "excluded rules still present")
		text := allStrings(rules)
		check(!strings.Contains(text, "zz"), "unsubstituted placeholder in alert rules")
		check(strings.Contains(text, "{{ $labels.pod }}") || strings.Contains(text, "{{ $value }}"), "Prometheus templating not preserved")
		check(strings.Contains(text, fmt.Sprintf("namespace=%q", ns)), "alert expressions not scoped to the namespace")
	}
}

func assertDashboard(r *render, dash M, sourcePath string) {
	check, status, name, ns := r.check, r.status, r.name, r.ns
	var model, source M
	if err := json.Unmarshal([]byte(str(dash, "spec", "json")), &model); err != nil {
		check(false, "dashboard spec.json is not JSON: %v", err)
		return
	}
	raw, err := os.ReadFile(sourcePath)
	if err == nil {
		err = json.Unmarshal(raw, &source)
	}
	if err != nil {
		check(false, "dashboard source %s: %v", sourcePath, err)
		return
	}
	uid := str(dash, "spec", "uid")
	check(str(model, "uid") == uid && uid == str(status, "monitoring", "dashboardUid"), "dashboard uid mismatch")
	check(len(uid) <= 40, "Grafana uids are limited to 40 chars")
	check(str(model, "title") == fmt.Sprintf("CloudNativePG / %s / %s", ns, name), "dashboard title %s", strconv.Quote(str(model, "title")))
	check(len(list(model, "panels")) == len(list(source, "panels")), "dashboard panels differ from source JSON")
	current := map[string]any{}
	for _, v := range list(model, "templating", "list") {
		current[str(v, "name")] = get(v, "current", "value")
	}
	check(equal(current["namespace"], ns) && equal(current["cluster"], name), "dashboard variables not preset")
	// Grafana legend templates like {{pod}} must survive the composition verbatim.
	m, _ := json.Marshal(model)
	s, _ := json.Marshal(source)
	check(strings.Count(string(m), "{{") == strings.Count(string(s), "{{"), "dashboard {{ }} legend formats altered")
}
