package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/bartvanbenthem/basis-ai/api/internal/doc"
)

var (
	// On the control plane: the namespace (the PostgresCluster XRs live there),
	// a Prometheus that only receives, Grafana. Namespaced objects only once the
	// namespace exists.
	projHub = set("namespace", "prometheus-serviceaccount", "prometheus", "prometheus-pvc", "grafana", "grafana-datasource")
	// In each location, wrapped in an Object named location-<location>-<name>:
	// the namespace, a Prometheus that scrapes, access and quota. Rendered once
	// the namespace on the control plane exists (the Objects live in it).
	projRemote = set("namespace", "prometheus-clusterrolebinding", "prometheus-serviceaccount", "prometheus", "prometheus-pvc")
	// With a backup bucket, in each location: its keys and the CronJob that checks
	// it reaches the bucket.
	projCheck = set("backup-check-s3", "backup-check")
)

func at(location string, keys map[string]bool) map[string]bool {
	return prefixed("location-"+location+"-", keys)
}

var projExpected = map[string]map[string]map[string]bool{
	"bare": {"empty": set("namespace", "usage-location-si-ske-demo")},
	"minimal": {"empty": set("namespace", "usage-location-si-ske-demo"),
		"observed": union(projHub, set("usage-location-si-ske-demo"), at("si-ske-demo", projRemote))},
	"full": {"empty": set("namespace", "usage-location-si-ske-demo", "usage-location-onprem-ams"),
		"observed": union(projHub, set("access-0", "access-1", "usage-location-si-ske-demo", "usage-location-onprem-ams"),
			at("si-ske-demo", union(projRemote, set("access-0", "access-1", "quota", "limitrange"))),
			at("onprem-ams", union(projRemote, set("access-0", "access-1", "quota", "limitrange"))))},
	"sites": {"empty": set("namespace", "usage-location-si-ske-demo", "usage-location-onprem-ams"),
		"observed": union(projHub, set("access-0", "prometheus-remote-write",
			"usage-location-si-ske-demo", "usage-location-onprem-ams"),
			at("si-ske-demo", union(projRemote, set("access-0", "quota", "limitrange"))),
			at("onprem-ams", union(projRemote, set("access-0", "quota", "limitrange"))))},
	// COSI: the project's BucketClass from the start; the claim and an access per
	// location once the project namespace exists.
	"bucket": {"empty": set("namespace", "usage-location-si-ske-demo", "usage-location-onprem-ams", "backup-bucketclass"),
		"observed": union(projHub, set("usage-location-si-ske-demo", "usage-location-onprem-ams", "backup-bucketclass",
			"backup-bucket", "backup-access-si-ske-demo", "backup-access-onprem-ams",
			"backup-sa-si-ske-demo", "backup-sa-onprem-ams",
			"backup-s3-si-ske-demo", "backup-s3-onprem-ams"),
			at("si-ske-demo", union(projRemote, projCheck)), at("onprem-ams", union(projRemote, projCheck)))},
	// The same while COSI grants si-ske-demo's access: onprem-ams's waits for it.
	"granting": {"empty": set("namespace", "usage-location-si-ske-demo", "usage-location-onprem-ams", "backup-bucketclass"),
		"observed": union(projHub, set("usage-location-si-ske-demo", "usage-location-onprem-ams", "backup-bucketclass",
			"backup-bucket", "backup-access-si-ske-demo",
			"backup-sa-si-ske-demo", "backup-sa-onprem-ams",
			"backup-s3-si-ske-demo", "backup-s3-onprem-ams"),
			at("si-ske-demo", union(projRemote, projCheck)), at("onprem-ams", union(projRemote, projCheck)))},
	// The same with a name too long for project-<name>-backups (see bucketClass).
	"bucket-long": {"empty": set("namespace", "usage-location-si-ske-demo", "usage-location-onprem-ams",
		"backup-bucketclass")},
	// No Location "nowhere": no ClusterUsage for it, and the Project isn't ready.
	"unregistered": {"empty": set("namespace")},
	// minimal with governance and the price catalog: the cost rules and dashboard.
	"governed": {"empty": set("namespace", "usage-location-si-ske-demo"),
		"observed": union(projHub, set("usage-location-si-ske-demo", "cost-rules", "cost-dashboard"), at("si-ske-demo", projRemote))},
}

func assertProject(r *render) {
	kase, state, status, conds, name, xr, composed := r.kase, r.state, r.status, r.conds, r.name, r.xr, r.composed
	check := r.check

	expected, ok := projExpected[kase][state]
	if !ok {
		check(false, "no expectations for case %s/%s", kase, state)
		return
	}
	check(sameKeys(composed, expected), "composed resources %v != expected %v", r.keys(), sortedKeys(expected))

	// --- namespace: the labels PostgresClusters and Backstage key on
	ns := composed["namespace"]
	labels := mp(ns, "metadata", "labels")
	check(str(ns, "metadata", "name") == name, "namespace name must equal the project name")
	check(str(labels, "platform.cndev.nl/project") == name, "namespace missing platform.cndev.nl/project label")
	check(str(labels, "dashboards.paas.cndev.nl/scope") == name,
		"namespace scope label must match the PostgresCluster dashboards' default instanceSelector")
	check(str(labels, "pod-security.kubernetes.io/enforce") == "baseline", "pod security baseline not enforced")
	if owner := str(xr, "spec", "owner"); owner != "" {
		check(str(labels, "backstage.io/owner") == owner, "owner label not set on namespace")
	}
	for _, key := range r.keys() {
		obj := composed[key]
		if key != "namespace" && !strings.HasPrefix(key, "usage-") && key != "backup-bucketclass" {
			check(str(obj, "metadata", "namespace") == name, "%s: not in the project namespace", key)
		}
		check(str(obj, "metadata", "labels", "platform.cndev.nl/project") == name, "%s: missing project label", key)
	}
	// --- governance: labels the admission policies read, status, cost rules
	gov := mp(status, "governance")
	classification, environment := "internal", "production"
	if kase == "governed" {
		classification, environment = "confidential", "sandbox"
		check(str(labels, "platform.cndev.nl/cost-center") == "CC-4711" && str(gov, "costCenter") == "CC-4711" &&
			equal(get(gov, "expired"), false) && str(gov, "currency") == "EUR", "governance status %s", repr(gov))
	}
	check(str(labels, "platform.cndev.nl/classification") == classification && str(labels, "platform.cndev.nl/environment") == environment &&
		str(gov, "classification") == classification, "classification and environment labels %s", repr(labels))
	check(!has(labels, "platform.cndev.nl/expired"), "not expired")
	if rules, ok := composed["cost-rules"]; ok {
		groups := list(rules, "spec", "groups")
		check(len(groups) == 2 && str(groups[0], "name") == "basis-cost" && str(groups[1], "name") == "basis-budget",
			"cost rules and budget alerts: %s", repr(groups))
		check(equal(get(composed["prometheus"], "spec", "ruleNamespaceSelector", "matchLabels", "kubernetes.io/metadata.name"), name),
			"the control-plane Prometheus evaluates the project's cost rules")
	}

	sites := mp(xr, "spec", "locations")
	siteLocs := []string{str(sites, "protected")} // in the order of sites.values()
	if has(sites, "recovery") {
		siteLocs = append(siteLocs, str(sites, "recovery"))
	}
	ann := mp(ns, "metadata", "annotations")
	check(equal(get(ann, "platform.cndev.nl/protected-location"), get(sites, "protected")) &&
		equal(get(ann, "platform.cndev.nl/recovery-location"), get(sites, "recovery")),
		"namespace must record the project's sites for the admission policy: %s", repr(ann))
	check(!has(ann, "platform.cndev.nl/locations"), "the old location list annotation is gone")
	check(!has(status, "locationNames"), "status.locationNames is gone")
	// The Location of si-ske-demo (required/sites.yaml) says schedulable: false.
	var unschedulable any
	if kase == "sites" {
		unschedulable = "si-ske-demo"
	}
	check(equal(get(ann, "platform.cndev.nl/unschedulable-locations"), unschedulable),
		"namespace must list the locations closed to new databases for the admission policy")

	// --- the COSI backup bucket
	bucketCase := kase == "bucket" || kase == "bucket-long" || kase == "granting"
	check((str(ann, "platform.cndev.nl/backup-bucket") == "true") == bucketCase,
		"namespace must say whether the project has a backup bucket, for the admission policy")
	// COSI names the bucket <class><claim UID>: the class gets 63 - 36 characters.
	bucketClass := fmt.Sprintf("project-%s-backups", name)
	if len(bucketClass) > 27 {
		sum := sha256.Sum256([]byte(name))
		bucketClass = fmt.Sprintf("prj-%s-%s", strings.TrimRight(name[:min(16, len(name))], "-"), hex.EncodeToString(sum[:])[:6])
	}
	if bucketCase {
		assertProjectBucket(r, bucketClass, sites, siteLocs)
	} else {
		check(!has(status, "backup"), "no backup status without COSI classes")
	}

	// --- registered locations: a ClusterUsage each, so the Location can't be deleted
	for _, key := range r.keys() {
		if !strings.HasPrefix(key, "usage-location-") {
			continue
		}
		obj := composed[key]
		loc := strings.TrimPrefix(key, "usage-location-")
		check(str(obj, "kind") == "ClusterUsage" && str(obj, "apiVersion") == "protection.crossplane.io/v1beta1",
			"%s: must be a ClusterUsage", key)
		check(equal(get(obj, "spec", "of"), M{"apiVersion": "platform.cndev.nl/v1alpha1", "kind": "Location",
			"resourceRef": M{"name": loc}}), "%s: spec.of %s", key, repr(get(obj, "spec", "of")))
		check(strings.Contains(str(obj, "spec", "reason"), name), "%s: reason must name the project", key)
	}

	// --- locations: Objects for the location's ClusterProviderConfig
	remote := map[string]map[string]M{} // site -> key without the location prefix -> Object
	siteNames := []string{"protected"}
	if has(sites, "recovery") {
		siteNames = append(siteNames, "recovery")
	}
	for _, site := range siteNames {
		loc := str(sites, site)
		prefix := "location-" + loc + "-"
		remote[site] = map[string]M{}
		for _, k := range r.keys() {
			if strings.HasPrefix(k, prefix) {
				remote[site][strings.TrimPrefix(k, prefix)] = composed[k]
			}
		}
		for _, key := range sortedKeys(remote[site]) {
			obj := remote[site][key]
			check(str(obj, "kind") == "Object", "%s/%s: objects in a location must be Objects", loc, key)
			check(equal(get(obj, "spec", "providerConfigRef"), M{"kind": "ClusterProviderConfig", "name": loc}),
				"%s/%s: providerConfigRef", loc, key)
			manifest := mp(obj, "spec", "forProvider", "manifest")
			var leaked []string
			for _, a := range sortedKeys(mp(manifest, "metadata", "annotations")) {
				if strings.Contains(a, "crossplane.io/") || a == "platform.cndev.nl/orphan" {
					leaked = append(leaked, a)
				}
			}
			check(len(leaked) == 0, "%s/%s: composition annotations leaked into the manifest: %v", loc, key, leaked)
			if key != "namespace" && key != "prometheus-clusterrolebinding" {
				check(str(manifest, "metadata", "namespace") == name, "%s/%s: not in the project namespace there", loc, key)
			}
			policies := get(obj, "spec", "managementPolicies")
			if key == "namespace" {
				p := strs(policies)
				check(len(p) > 0 && !slices.Contains(p, "Delete") && !slices.Contains(p, "*"),
					"%s: the namespace in a location must never be deleted by Crossplane", loc)
			} else {
				check(policies == nil, "%s/%s: only the namespace is orphaned", loc, key)
			}
		}
	}
	for _, key := range r.keys() {
		if !strings.HasPrefix(key, "location-") {
			check(str(composed[key], "kind") != "Object", "%s: control-plane objects are composed directly", key)
		}
	}
	_, crb := composed["prometheus-clusterrolebinding"]
	_, quota := composed["quota"]
	_, limits := composed["limitrange"]
	check(!crb && !quota && !limits, "the control plane scrapes nothing and runs no databases: no Prometheus binding, no quota")

	// --- observability wiring
	for _, site := range siteNames {
		objs, loc := remote[site], str(sites, site)
		if obj, ok := objs["prometheus-clusterrolebinding"]; ok {
			manifest := mp(obj, "spec", "forProvider", "manifest")
			check(str(manifest, "roleRef", "name") == "basis:project-prometheus", "CRB must bind the shared ClusterRole")
			check(equal(get(manifest, "subjects"), L{M{"kind": "ServiceAccount", "name": "prometheus", "namespace": name}}),
				"CRB subject must be the project's prometheus ServiceAccount")
		}
		obj, ok := objs["prometheus"]
		if !ok {
			continue
		}
		prom := mp(obj, "spec", "forProvider", "manifest", "spec")
		check(str(prom, "serviceAccountName") == "prometheus", "Prometheus must use its ServiceAccount")
		pmNS := get(prom, "podMonitorNamespaceSelector", "matchExpressions", 0, "values")
		check(equal(get(prom, "podMonitorSelector"), M{}) && equal(pmNS, L{name, "cnpg-system"}),
			"Prometheus must scrape this namespace's and the CNPG operator's PodMonitors")
		ruleNS := get(prom, "ruleNamespaceSelector", "matchExpressions", 0, "values")
		if kase == "full" {
			check(str(prom, "retention") == "30d", "retention not passed through")
			vct := mp(prom, "storage", "volumeClaimTemplate", "spec")
			check(str(vct, "storageClassName") == "fast" && str(vct, "resources", "requests", "storage") == "50Gi",
				"Prometheus storage not passed through")
			// From the EnvironmentConfig.
			check(equal(ruleNS, L{name, "monitoring"}), "ruleNamespaceSelector %s", repr(ruleNS))
			check(equal(get(prom, "serviceMonitorSelector", "matchLabels"), M{"release": "kps"}), "serviceMonitorLabels from env")
			check(equal(get(prom, "serviceMonitorSelector", "matchExpressions", 0, "values"), L{"kube-prometheus-stack-apiserver"}),
				"excludeApps from env")
		} else {
			check(equal(ruleNS, L{name, "prometheus-operator-system"}), "default ruleNamespaceSelector %s", repr(ruleNS))
			check(equal(get(prom, "serviceMonitorSelector", "matchLabels"), M{"release": "prometheus-operator"}),
				"default serviceMonitorLabels")
		}
		check(equal(get(prom, "externalLabels"), M{"location": loc, "site": site}),
			"%s: Prometheus must label its location and site: %s", loc, repr(get(prom, "externalLabels")))
		var wantRW any
		if kase == "sites" {
			wantRW = L{M{"url": fmt.Sprintf("https://prometheus-%s.example.com/api/v1/write", name)}}
		}
		check(equal(get(prom, "remoteWrite"), wantRW), "%s: remoteWrite %s", loc, repr(get(prom, "remoteWrite")))
		check(!has(prom, "enableRemoteWriteReceiver"), "only the control plane's Prometheus receives")
	}

	if obj, ok := composed["prometheus"]; ok {
		prom := mp(obj, "spec")
		check(equal(get(prom, "enableRemoteWriteReceiver"), true), "the control plane's Prometheus receives remote writes")
		var scraping []string
		_, costRules := composed["cost-rules"]
		for _, k := range sortedKeys(prom) {
			// With the price catalog it evaluates the project's cost rules, still scraping nothing.
			if costRules && (k == "ruleSelector" || k == "ruleNamespaceSelector") {
				continue
			}
			if strings.HasSuffix(k, "Selector") {
				scraping = append(scraping, k)
			}
		}
		check(len(scraping) == 0, "the control plane's Prometheus scrapes nothing: %v", scraping)
		check(!has(prom, "externalLabels") && !has(prom, "remoteWrite"), "the control plane's Prometheus only receives")
	}

	if pvc, ok := composed["prometheus-pvc"]; ok {
		// Must be the claim the StatefulSet's volumeClaimTemplate resolves to, or
		// Prometheus would get a second, unmanaged volume.
		check(str(pvc, "metadata", "name") == "prometheus-prometheus-db-prometheus-prometheus-0", "PVC name")
		vct := mp(composed["prometheus"], "spec", "storage", "volumeClaimTemplate", "spec")
		check(equal(get(pvc, "spec", "resources"), get(vct, "resources")), "PVC size must match the volumeClaimTemplate")
		check(equal(get(pvc, "spec", "storageClassName"), get(vct, "storageClassName")), "PVC storageClass")
	}

	if ing, ok := composed["prometheus-remote-write"]; ok {
		rule := get(ing, "spec", "rules", 0)
		check(str(rule, "host") == fmt.Sprintf("prometheus-%s.example.com", name), "remote-write ingress host")
		var paths L
		for _, p := range list(rule, "http", "paths") {
			paths = append(paths, L{get(p, "path"), get(p, "pathType")})
		}
		check(equal(paths, L{L{"/api/v1/write", "Exact"}}), "the remote-write ingress must expose only /api/v1/write")
		check(str(ing, "metadata", "annotations", "nginx.ingress.kubernetes.io/whitelist-source-range") == "192.0.2.0/24",
			"ingress annotations from project-defaults")
		check(str(status, "prometheus", "remoteWriteUrl") == fmt.Sprintf("https://prometheus-%s.example.com/api/v1/write", name),
			"status.prometheus.remoteWriteUrl")
	}

	if graf, ok := composed["grafana"]; ok {
		check(str(graf, "metadata", "labels", "dashboards.paas.cndev.nl/scope") == name,
			"Grafana must carry the scope label dashboards select on")
		check(str(graf, "spec", "config", "security", "allow_embedding") == "true", "embedding must be allowed")
		host := map[string]string{"minimal": "grafana-demo.10.0.0.1.nip.io", "governed": "grafana-demo.10.0.0.1.nip.io", "full": "grafana-team-payments.example.com",
			"sites": "grafana-team-ledger.example.com"}[kase]
		switch {
		case host == "": // no Grafana ingress in this case's project-defaults
			check(!has(graf, "ingress", "spec") && !has(status, "url", "grafana"), "no ingress without hostTemplate")
		default:
			got := str(graf, "spec", "ingress", "spec", "rules", 0, "host")
			check(got == host, "ingress host %s != %s", strconv.Quote(got), strconv.Quote(host))
			if kase == "full" {
				check(equal(get(graf, "spec", "ingress", "spec", "tls"), L{M{"hosts": L{host}, "secretName": "wildcard-example-com"}}),
					"TLS from env")
				check(str(status, "grafana", "url") == "https://"+host, "status.grafana.url must use https")
			} else {
				check(str(status, "grafana", "url") == "http://"+host, "status.grafana.url")
			}
		}
	}

	if obj, ok := composed["grafana-datasource"]; ok {
		ds := mp(obj, "spec")
		check(str(ds, "datasource", "name") == "prometheus", "datasource must be named 'prometheus'")
		check(str(ds, "datasource", "url") == fmt.Sprintf("http://prometheus-operated.%s.svc:9090", name), "datasource url")
		check(equal(get(ds, "instanceSelector", "matchLabels"), M{"dashboards.paas.cndev.nl/scope": name}), "datasource selector")
	}

	// --- access and quota: access on the control plane and in each location, quota only in the locations
	if kase == "full" && state == "observed" {
		type place struct {
			where string
			objs  map[string]M
		}
		places := []place{{"control plane", composed}}
		for _, site := range siteNames {
			objs := map[string]M{}
			for _, k := range []string{"access-0", "access-1"} {
				if o, ok := remote[site][k]; ok {
					objs[k] = mp(o, "spec", "forProvider", "manifest")
				}
			}
			places = append(places, place{str(sites, site), objs})
		}
		for _, p := range places {
			bindings := M{}
			names := map[string]bool{}
			for _, k := range []string{"access-0", "access-1"} {
				bindings[str(p.objs[k], "roleRef", "name")] = get(p.objs[k], "subjects", 0, "name")
				names[str(p.objs[k], "metadata", "name")] = true
			}
			check(equal(bindings, M{"edit": "payments-devs", "view": "auditors"}), "%s: RoleBindings %s", p.where, repr(bindings))
			check(len(names) == 2, "RoleBinding names must be unique")
		}
		for _, site := range siteNames {
			hard := get(remote[site]["quota"], "spec", "forProvider", "manifest", "spec", "hard")
			check(equal(hard, M{"requests.cpu": "8", "requests.memory": "32Gi", "limits.memory": "32Gi",
				"requests.storage": "200Gi"}), "%s: quota %s", str(sites, site), repr(hard))
		}
	}

	// --- readiness / status
	check(str(status, "namespace") == name, "status.namespace")
	if kase == "bare" {
		check(!has(status, "prometheus") && !has(status, "grafana"), "disabled components must not be in status")
	}
	if kase == "unregistered" {
		const msg = "no Location nowhere; register the cluster first"
		check(str(status, "message") == msg, "status.message %s", repr(get(status, "message")))
		locations := get(status, "locations")
		if locations == nil {
			locations = L{}
		}
		check(equal(locations, L{M{"location": "nowhere", "site": "protected", "ready": false, "message": msg}}),
			"status.locations %s", repr(get(status, "locations")))
	}
	switch {
	case state == "empty":
		check(equal(get(status, "ready"), false), "status.ready should be false before anything exists")
		check(str(conds["Ready"], "status") == "False", "XR Ready should be False")
		check(str(conds["ObservabilityReady"], "status") == "False", "ObservabilityReady should be False")
	case kase == "granting":
		check(equal(get(status, "ready"), false) &&
			str(status, "message") == "Waiting for COSI to grant backup bucket access in si-ske-demo, onprem-ams",
			"status %s", repr(get(status, "message")))
		check(str(conds["Ready"], "status") == "False", "XR Ready waits for the BucketAccess: %s", repr(conds["Ready"]))
	case kase != "bucket":
		check(equal(get(status, "ready"), true), "status.ready should be true, got %s", repr(get(status, "ready")))
		check(str(conds["Ready"], "status") == "True", "XR Ready should be True, got %s", repr(conds["Ready"]))
		check(str(conds["ObservabilityReady"], "status") == "True", "ObservabilityReady should be True")
		check(str(status, "prometheus", "url") == fmt.Sprintf("http://prometheus-operated.%s.svc:9090", name),
			"status.prometheus.url")
		var want, got L
		for _, site := range siteNames {
			want = append(want, L{str(sites, site), site, true})
		}
		for _, l := range list(status, "locations") {
			got = append(got, L{get(l, "location"), get(l, "site"), get(l, "ready")})
		}
		check(equal(got, want), "status.locations %s", repr(get(status, "locations")))
		if _, ok := composed["prometheus"]; kase != "sites" && ok {
			check(strings.Contains(str(status, "message"), "Grafana shows none"),
				"without remote write the message must say Grafana stays empty: %s", repr(get(status, "message")))
		}
	}
}

func assertProjectBucket(r *render, bucketClass string, sites M, siteLocs []string) {
	kase, state, status, name, composed := r.kase, r.state, r.status, r.name, r.composed
	check := r.check

	check((kase == "bucket-long") == strings.HasPrefix(bucketClass, "prj-"),
		"case %s must exercise its class form: %s", kase, bucketClass)
	cls := composed["backup-bucketclass"]
	check(len(str(cls, "metadata", "name")) <= 27, "BucketClass name too long for a bucket name: %s", str(cls, "metadata", "name"))
	check(str(cls, "kind") == "BucketClass" && str(cls, "metadata", "name") == bucketClass &&
		!has(cls, "namespace", "metadata") && str(cls, "deletionPolicy") == "Retain" &&
		str(cls, "driverName") == "cloudian-cosi-driver" && equal(get(cls, "parameters"), M{"storagePolicy": "replicated-3"}),
		"BucketClass must keep the backups (Retain) and use the driver from project-defaults: %s", repr(cls))
	if state == "observed" {
		claim := composed["backup-bucket"]
		check(str(claim, "kind") == "BucketClaim" && str(claim, "metadata", "name") == "backups" &&
			equal(get(claim, "spec"), M{"bucketClassName": bucketClass, "protocols": L{"S3"}}),
			"BucketClaim %s", repr(claim))
		for _, loc := range siteLocs {
			if kase == "granting" && loc == str(sites, "recovery") {
				continue
			}
			acc := composed["backup-access-"+loc]
			check(str(acc, "kind") == "BucketAccess" && str(acc, "metadata", "name") == "backups-"+loc &&
				equal(get(acc, "spec"), M{"bucketClaimName": "backups", "bucketAccessClassName": "backups-keys",
					"credentialsSecretName": "cosi-backups-" + loc,
					"serviceAccountName":    "backups-" + loc, "protocol": "S3"}),
				"%s: BucketAccess %s", loc, repr(get(acc, "spec")))
			sa := composed["backup-sa-"+loc]
			check(str(sa, "kind") == "ServiceAccount" && str(sa, "metadata", "name") == "backups-"+loc &&
				str(sa, "metadata", "namespace") == name && equal(get(sa, "automountServiceAccountToken"), false),
				"%s: the IAM access class needs a ServiceAccount: %s", loc, repr(sa))
		}
	}
	backup := mp(status, "backup")
	check(!has(backup, "namespace") || str(backup, "namespace") == name, "status.backup %s", repr(backup))
	if state == "empty" {
		creds := get(backup, "credentials")
		check(equal(get(backup, "ready"), false) && (creds == nil || equal(creds, M{}) || equal(creds, L{})),
			"status.backup %s", repr(backup))
		check(strings.Contains(str(status, "message"), "the backup bucket (COSI)"), "message %s", repr(get(status, "message")))
	} else {
		// COSI's Secrets are namespaced: they come back in .requiredResources only.
		wantCreds := M{}
		for _, loc := range siteLocs {
			wantCreds[loc] = "backup-s3-" + loc
		}
		check(equal(get(backup, "ready"), true) && str(backup, "bucket") == name+"-backups-0f3a" &&
			str(backup, "destinationPath") == fmt.Sprintf("s3://%s-backups-0f3a/barman", name) &&
			str(backup, "endpoint") == "https://s3.example.com" && str(backup, "region") == "region-1" &&
			equal(get(backup, "credentials"), wantCreds),
			"status.backup %s", repr(backup))
		check(!strings.Contains(str(status, "message"), "the backup bucket (COSI)"), "message %s", repr(get(status, "message")))
	}
	// The inventory of backup folders: kept from the last status (old-db's
	// cluster is gone, its folder stays restorable), updated from the
	// clusters' ObjectStores in this bucket (ledger-db archives elsewhere).
	servers := map[string]M{}
	var order []string
	for _, s := range list(backup, "servers") {
		n := str(s, "serverName")
		if _, dup := servers[n]; !dup {
			order = append(order, n)
		}
		servers[n] = mp(s)
	}
	if state == "empty" {
		anyActive := false
		for _, s := range servers {
			anyActive = anyActive || equal(get(s, "active"), true)
		}
		check(sameKeys(servers, set("old-db", "orders-db")) && !anyActive,
			"before the bucket is known the last inventory stays, inactive: %s", repr(servers))
	} else {
		check(slices.Equal(order, []string{"old-db", "orders-db", "orders-db-onprem-ams"}), "servers %v", order)
		check(equal(servers["old-db"], M{"serverName": "old-db", "cluster": "old-db", "location": "si-ske-demo", "active": false,
			"postgresVersion": 16, "database": "app", "owner": "app",
			"firstRecoverabilityPoint": "2026-09-01T02:00:00Z",
			"lastSuccessfulBackup":     "2026-09-30T02:00:00Z"}), "old-db %s", repr(servers["old-db"]))
		check(equal(servers["orders-db"], M{"serverName": "orders-db", "cluster": "orders-db", "location": "si-ske-demo", "active": true,
			"postgresVersion": 17, "database": "orders", "owner": "orders",
			"firstRecoverabilityPoint": "2026-10-02T02:00:00Z",
			"lastSuccessfulBackup":     "2026-10-08T02:00:00Z"}), "orders-db %s", repr(servers["orders-db"]))
		ams := servers["orders-db-onprem-ams"]
		check(str(ams, "location") == "onprem-ams" && equal(get(ams, "active"), true) && !has(ams, "firstRecoverabilityPoint"),
			"%s", repr(ams))
	}
	if state == "empty" {
		return
	}
	for i, loc := range siteLocs {
		sec := composed["backup-s3-"+loc]
		data := M{}
		var decodeErr error
		for k, v := range mp(sec, "data") {
			raw, err := base64.StdEncoding.DecodeString(fmt.Sprint(v))
			if err != nil {
				decodeErr = err
			}
			data[k] = string(raw)
		}
		check(decodeErr == nil && str(sec, "kind") == "Secret" && str(sec, "metadata", "namespace") == name &&
			equal(data, M{"ACCESS_KEY_ID": fmt.Sprintf("FAKEKEYID%d", i), "ACCESS_SECRET_KEY": fmt.Sprintf("fake-secret-%d", i),
				"REGION": "region-1"}),
			"%s: keys unpacked from COSI's BucketInfo: %v", loc, doc.Keys(data))
		// The check, from the location itself, with that location's keys.
		obj := composed["location-"+loc+"-backup-check-s3"]
		var wantRefs L
		for _, f := range []string{"data", "type"} {
			wantRefs = append(wantRefs, M{"patchesFrom": M{"apiVersion": "v1", "kind": "Secret", "name": "backup-s3-" + loc,
				"namespace": name, "fieldPath": f}})
		}
		check(str(obj, "spec", "providerConfigRef", "name") == loc && equal(get(obj, "spec", "references"), wantRefs) &&
			!has(obj, "data", "spec", "forProvider", "manifest") &&
			!has(obj, "platform.cndev.nl/copy-from", "spec", "forProvider", "manifest", "metadata", "annotations"),
			"%s: backup-check-s3 must copy backup-s3-%s from the control plane: %s", loc, loc, repr(get(obj, "spec")))
		cj := mp(composed["location-"+loc+"-backup-check"], "spec", "forProvider", "manifest")
		pod := mp(cj, "spec", "jobTemplate", "spec", "template", "spec")
		c := mp(pod, "containers", 0)
		env := M{}
		for _, e := range list(c, "env") {
			v := get(e, "value")
			if s, _ := v.(string); s == "" {
				v = get(e, "valueFrom", "secretKeyRef", "name")
			}
			env[str(e, "name")] = v
		}
		check(str(cj, "kind") == "CronJob" && str(cj, "metadata", "namespace") == name &&
			str(cj, "spec", "concurrencyPolicy") == "Forbid" &&
			equal(env, M{"LOCATION": loc, "S3_ENDPOINT": "https://s3.example.com",
				"S3_BUCKET": name + "-backups-0f3a", "ACCESS_KEY_ID": "backup-check-s3",
				"ACCESS_SECRET_KEY": "backup-check-s3", "REGION": "backup-check-s3"}) &&
			equal(get(c, "securityContext", "readOnlyRootFilesystem"), true) &&
			equal(get(pod, "securityContext", "runAsNonRoot"), true) &&
			doc.IsInt(get(pod, "securityContext", "runAsUser")),
			"%s: backup-check CronJob %s", loc, repr(get(cj, "spec")))
	}
	// hack/observe reports each CronJob's last run as successful.
	var want L
	for _, loc := range siteLocs {
		want = append(want, M{"location": loc, "state": "Reachable", "lastCheckTime": "2026-01-01T00:05:00Z",
			"lastSuccessTime": "2026-01-01T00:05:04Z"})
	}
	check(equal(get(backup, "reachability"), want), "status.backup.reachability %s", repr(get(backup, "reachability")))
}
