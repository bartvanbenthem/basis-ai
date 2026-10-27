// Package project composes a Project (platform.cndev.nl/v1alpha1): a team's
// namespace on the control plane and in each of its locations, with its own
// Prometheus and Grafana, access, an optional quota and a backup bucket.
//
// On the control plane ("local", which runs no workloads):
//
//	namespace                   labels platform.cndev.nl/project and
//	                            dashboards.paas.cndev.nl/scope = <name>; where the
//	                            workload XRs live. Annotations record the locations
//	                            for the admission policies and compositions
//	prometheus-serviceaccount,  receives the samples of the project's locations
//	prometheus, prometheus-pvc  (remote write), scrapes nothing
//	grafana, grafana-datasource what the workloads' dashboards import into
//	prometheus-remote-write     Ingress for /api/v1/write only, with
//	                            prometheus.remoteWrite in project-defaults
//	access-<i>                  RoleBinding per spec.access entry
//	backup-bucketclass          BucketClass project-<name>-backups (COSI,
//	                            Retain), unless spec.backup names one
//	backup-bucket               BucketClaim backups
//	backup-sa-<loc>,            per location: a ServiceAccount and BucketAccess
//	backup-access-<loc>         with its own S3 keys, granted one at a time
//	backup-s3-<loc>             those keys unpacked from COSI's BucketInfo JSON
//	usage-location-<loc>        ClusterUsage: a Location can't go while used
//	cost-rules, cost-dashboard  the project's cost and budget alerts (governance.go)
//
// In each location (spec.locations.protected and .recovery), wrapped in
// provider-kubernetes Objects named location-<loc>-<key>:
//
//	namespace                   never deleted by Crossplane
//	prometheus-clusterrolebinding -> ClusterRole basis:project-prometheus
//	prometheus-serviceaccount, prometheus, prometheus-pvc
//	                            scrapes the namespace, the CNPG operator and the
//	                            cluster metrics; remote write to the control plane
//	access-<i>, quota, limitrange
//	backup-check-s3, backup-check  every few minutes a write, read and delete of a
//	                            test object in the bucket (status.backup.reachability)
//
// Cluster-wide settings come from the EnvironmentConfig project-defaults;
// every key is optional. Namespaced objects are only rendered once their
// namespace is observed.
package project

import (
	"crypto/sha1" //nolint:gosec // names, not a security boundary
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type Object = map[string]any

// Requirement is a resource the composition needs to see: by name, or by
// labels; Namespace empty for a cluster-scoped one.
type Requirement struct {
	APIVersion, Kind, Namespace, Name string
	Labels                            map[string]string
}

type Input struct {
	XR       Object
	Observed map[string]Object
	Required map[string][]Object
}

type Composed struct {
	Object Object
	Ready  bool
}

type Condition struct {
	Status  bool
	Reason  string
	Message string
}

type Output struct {
	Composed  map[string]Composed
	Status    Object
	Condition Condition
}

const (
	requiredDefaults     = "defaults"
	requiredBackupStores = "backup-stores"
)

// settings is what both Requirements and Compose derive from the XR and
// project-defaults.
type settings struct {
	xr, spec, env Object
	name, ns      string
	siteLocations []string
	bucketOn      bool
	ownClass      bool
	bucketClass   string
	accessClass   string
	cosi          Object
	labels        map[string]string
	promEnabled   bool
	grafEnabled   bool
	host, scheme  string
	ingress       Object
	remoteWrite   Object
	rwHost, rwURL string
	hasRemote     bool
	gov           governance
}

func newSettings(xr Object, required map[string][]Object) *settings {
	s := &settings{xr: xr}
	s.spec, _ = xr["spec"].(Object)
	if s.spec == nil {
		s.spec = Object{}
	}
	s.name = str(dig(xr, "metadata", "name"))
	s.ns = s.name
	s.env = Object{}
	if items := required[requiredDefaults]; len(items) > 0 {
		if d, ok := dig(items[0], "data").(Object); ok {
			s.env = d
		}
	}
	for _, site := range []string{"protected", "recovery"} {
		if l := str(dig(s.spec, "locations", site)); l != "" {
			s.siteLocations = append(s.siteLocations, l)
		}
	}
	s.labels = map[string]string{
		"app.kubernetes.io/managed-by": "crossplane",
		"app.kubernetes.io/part-of":    "basis",
		"platform.cndev.nl/project":    s.name,
	}

	pb := obj(s.spec["backup"])
	s.cosi = obj(dig(s.env, "backup", "cosi"))
	// The project's own BucketClass (Retain) unless spec.backup names one;
	// project-defaults bucketClassName is the fallback without a driverName.
	s.ownClass = str(pb["bucketClassName"]) == "" && str(s.cosi["driverName"]) != ""
	s.bucketClass = or(str(pb["bucketClassName"]), str(s.cosi["bucketClassName"]))
	if s.ownClass {
		// COSI names the bucket <class><claim UID> (36 characters) and S3
		// allows 63, so the class gets 27.
		s.bucketClass = fmt.Sprintf("project-%s-backups", s.name)
		if len(s.bucketClass) > 27 {
			s.bucketClass = fmt.Sprintf("prj-%s-%s", strings.TrimSuffix(trunc(s.name, 16), "-"), trunc(sha256hex(s.name), 6))
		}
	}
	s.gov = newGovernance(s.spec, required)
	s.accessClass = or(str(pb["bucketAccessClassName"]), str(s.cosi["bucketAccessClassName"]))
	s.bucketOn = boolOr(pb["bucket"], true) && s.bucketClass != "" && s.accessClass != ""

	obs := obj(s.spec["observability"])
	s.promEnabled = boolOr(dig(obs, "prometheus", "enabled"), true)
	s.grafEnabled = boolOr(dig(obs, "grafana", "enabled"), true)
	s.ingress = obj(dig(s.env, "grafana", "ingress"))
	if tpl := str(s.ingress["hostTemplate"]); s.grafEnabled && boolOr(dig(obs, "grafana", "ingress"), true) && tpl != "" {
		s.host = strings.ReplaceAll(tpl, "{project}", s.name)
	}
	s.scheme = or(str(s.ingress["scheme"]), "http")

	s.hasRemote = len(s.siteLocations) > 0
	s.remoteWrite = obj(dig(s.env, "prometheus", "remoteWrite"))
	if tpl := str(s.remoteWrite["hostTemplate"]); tpl != "" {
		s.rwHost = strings.ReplaceAll(tpl, "{project}", s.name)
	}
	if s.hasRemote && s.promEnabled && s.rwHost != "" {
		s.rwURL = fmt.Sprintf("%s://%s/api/v1/write", or(str(s.remoteWrite["scheme"]), "https"), s.rwHost)
	}
	return s
}

// Requirements are what the composition reads besides its composed
// resources. They depend on project-defaults (the backup classes), so they
// settle on the second round.
func Requirements(xr Object, required map[string][]Object) map[string]Requirement {
	s := newSettings(xr, required)
	reqs := map[string]Requirement{
		requiredDefaults: {APIVersion: "apiextensions.crossplane.io/v1beta1", Kind: "EnvironmentConfig", Name: "project-defaults"},
		// The price catalog (governance.go); optional.
		requiredPrices: {APIVersion: "apiextensions.crossplane.io/v1beta1", Kind: "EnvironmentConfig", Name: "basis-prices"},
	}
	for _, l := range s.siteLocations {
		reqs["location-"+l] = Requirement{APIVersion: "platform.cndev.nl/v1alpha1", Kind: "Location", Name: l}
		if s.bucketOn {
			// What COSI wrote for this location's BucketAccess.
			reqs["cosi-"+l] = Requirement{APIVersion: "v1", Kind: "Secret", Namespace: s.ns, Name: "cosi-backups-" + l}
		}
	}
	if s.bucketOn {
		// The PostgresClusters' backup stores, for the inventory of the bucket.
		reqs[requiredBackupStores] = Requirement{APIVersion: "kubernetes.m.crossplane.io/v1alpha1", Kind: "Object",
			Namespace: s.ns, Labels: map[string]string{"postgres.cndev.nl/backup-store": "true"}}
	}
	return reqs
}

// member is the control plane ("local") or one of the project's locations.
type member struct {
	location, site, prefix string
	observed               map[string]Object
}

func (m *member) local() bool { return m.location == "local" }

// memberStatus is what each member reports back for the XR's status.
type memberStatus struct {
	location, site string
	waiting        []string
	problem        string
	backupCheck    Object
}

type backupCheck struct{ endpoint, bucket, image, schedule string }

// Compose renders the desired state of a Project.
func Compose(in Input) *Output {
	s := newSettings(in.XR, in.Required)
	out := &Output{Composed: map[string]Composed{}}
	observed := in.Observed

	// Observed, normalised: an Object stands for the object it manages.
	live := map[string]Object{}
	for k, v := range observed {
		if str(v["kind"]) == "Object" && strings.HasPrefix(str(v["apiVersion"]), "kubernetes.m.crossplane.io/") {
			if m, ok := dig(v, "status", "atProvider", "manifest").(Object); ok && len(m) > 0 {
				live[k] = m
			}
			continue
		}
		live[k] = v
	}

	members := []*member{{location: "local"}}
	for _, site := range []string{"protected", "recovery"} {
		if l := str(dig(s.spec, "locations", site)); l != "" {
			members = append(members, &member{location: l, site: site, prefix: "location-" + l + "-"})
		}
	}
	// The Location objects of the other locations.
	registered := map[string]bool{}
	var unschedulable []string
	for _, m := range members[1:] {
		if items := in.Required["location-"+m.location]; len(items) > 0 {
			registered[m.location] = true
			if b, ok := dig(items[0], "spec", "schedulable").(bool); ok && !b {
				unschedulable = append(unschedulable, m.location)
			}
		}
	}
	// Objects live in the project namespace here: none before it exists.
	hubNs := live["namespace"] != nil

	// What each location's backup check needs: the bucket and its keys.
	checks := map[string]*backupCheck{}
	checkCfg := obj(dig(s.env, "backup", "check"))
	bucketName := str(dig(observed["backup-bucket"], "status", "bucketName"))
	if s.bucketOn && hubNs && boolOr(checkCfg["enabled"], true) && bucketName != "" {
		for _, loc := range s.siteLocations {
			if s3 := cosiS3(in.Required["cosi-"+loc]); s3 != nil && str(s3["endpoint"]) != "" && str(s3["accessKeyID"]) != "" && str(s3["accessSecretKey"]) != "" {
				checks[loc] = &backupCheck{endpoint: str(s3["endpoint"]), bucket: bucketName,
					image: or(str(checkCfg["image"]), "curlimages/curl:8.16.0"), schedule: or(str(checkCfg["schedule"]), "*/5 * * * *")}
			}
		}
	}

	// Every member's objects.
	var statuses []memberStatus
	for _, m := range members {
		m.observed = map[string]Object{}
		for k, v := range live {
			if strings.HasPrefix(k, m.prefix) {
				m.observed[strings.TrimPrefix(k, m.prefix)] = v
			}
		}
		objects, st := s.member(m, unschedulable, checks[m.location])
		if !m.local() && !hubNs {
			st.waiting = []string{"the project namespace on the control plane"}
		}
		if !m.local() && !registered[m.location] {
			st.problem = fmt.Sprintf("no Location %s; register the cluster first", m.location)
		}
		statuses = append(statuses, st)
		if !m.local() && !hubNs {
			continue
		}
		for _, o := range objects {
			key := m.prefix + o.key
			if m.local() {
				out.Composed[key] = Composed{Object: o.manifest, Ready: o.ready}
				continue
			}
			out.Composed[key] = s.wrap(key, m.location, o)
		}
	}

	// The backup bucket: claim, an access per location, its keys unpacked.
	var bucket Object
	var ungranted []string
	if s.bucketOn && s.ownClass {
		// Retain: deleting the Project (or the claim) leaves the bucket and
		// its backups.
		bc := Object{
			"apiVersion": "objectstorage.k8s.io/v1alpha1", "kind": "BucketClass",
			"metadata":   Object{"name": s.bucketClass, "labels": s.labelsObj()},
			"driverName": str(s.cosi["driverName"]), "deletionPolicy": "Retain",
		}
		if params := obj(s.cosi["parameters"]); len(params) > 0 {
			p := Object{}
			for k, v := range params {
				p[k] = fmt.Sprint(v)
			}
			bc["parameters"] = p
		}
		out.Composed["backup-bucketclass"] = Composed{Object: bc, Ready: observed["backup-bucketclass"] != nil}
	}
	if s.bucketOn {
		bucket = Object{"ready": false, "namespace": s.ns}
	}
	if s.bucketOn && hubNs {
		claim := observed["backup-bucket"]
		bucketName := str(dig(claim, "status", "bucketName"))
		bucketReady := boolOr(dig(claim, "status", "bucketReady"), false) && bucketName != ""
		credentials := map[string]any{}
		endpoint, region := "", ""
		out.Composed["backup-bucket"] = Composed{Ready: bucketReady, Object: Object{
			"apiVersion": "objectstorage.k8s.io/v1alpha1", "kind": "BucketClaim",
			"metadata": s.meta("backups"),
			"spec":     Object{"bucketClassName": s.bucketClass, "protocols": []any{"S3"}},
		}}
		// One grant at a time: concurrent grants race on the Bucket's
		// finalizer, and a grant retried after a conflict fails for good.
		granting := false
		for _, loc := range s.siteLocations {
			access := observed["backup-access-"+loc]
			granted := boolOr(dig(access, "status", "accessGranted"), false)
			// The COSI sidecar refuses an IAM-type access class without a
			// ServiceAccount; nothing runs as it.
			sa := s.meta("backups-" + loc)
			sa["annotations"] = Object{"platform.cndev.nl/location": loc}
			out.Composed["backup-sa-"+loc] = Composed{Ready: true, Object: Object{
				"apiVersion": "v1", "kind": "ServiceAccount", "metadata": sa, "automountServiceAccountToken": false,
			}}
			if !granted {
				ungranted = append(ungranted, loc)
			}
			if access != nil || !granting {
				if !granted {
					granting = true
				}
				meta := s.meta("backups-" + loc)
				meta["annotations"] = Object{"platform.cndev.nl/location": loc}
				out.Composed["backup-access-"+loc] = Composed{Ready: granted, Object: Object{
					"apiVersion": "objectstorage.k8s.io/v1alpha1", "kind": "BucketAccess", "metadata": meta,
					"spec": Object{"bucketClaimName": "backups", "bucketAccessClassName": s.accessClass,
						"credentialsSecretName": "cosi-backups-" + loc, "serviceAccountName": "backups-" + loc, "protocol": "S3"},
				}}
			}
			// COSI's Secret holds one BucketInfo JSON document; CNPG needs
			// the keys as Secret keys of their own.
			if s3 := cosiS3(in.Required["cosi-"+loc]); s3 != nil && str(s3["accessKeyID"]) != "" && str(s3["accessSecretKey"]) != "" {
				endpoint, region = str(s3["endpoint"]), str(s3["region"])
				credentials[loc] = "backup-s3-" + loc
				data := Object{"ACCESS_KEY_ID": b64(str(s3["accessKeyID"])), "ACCESS_SECRET_KEY": b64(str(s3["accessSecretKey"]))}
				if r := str(s3["region"]); r != "" {
					data["REGION"] = b64(r)
				}
				meta := s.meta("backup-s3-" + loc)
				meta["annotations"] = Object{"platform.cndev.nl/location": loc}
				out.Composed["backup-s3-"+loc] = Composed{Ready: true, Object: Object{
					"apiVersion": "v1", "kind": "Secret", "metadata": meta, "type": "Opaque", "data": data,
				}}
			}
		}
		bucket = Object{"ready": bucketReady && len(credentials) == len(s.siteLocations) && endpoint != "",
			"bucket": bucketName, "endpoint": endpoint, "region": region, "namespace": s.ns, "credentials": credentials}
	}

	servers := s.inventory(bucket, in.Required[requiredBackupStores])

	// A ClusterUsage per registered location: no deleting a Location a
	// Project uses.
	for loc := range registered {
		out.Composed["usage-location-"+loc] = Composed{Ready: true, Object: Object{
			"apiVersion": "protection.crossplane.io/v1beta1", "kind": "ClusterUsage",
			"metadata": Object{"name": fmt.Sprintf("project-%s-location-%s", s.name, loc), "labels": s.labelsObj()},
			"spec": Object{
				"of":     Object{"apiVersion": "platform.cndev.nl/v1alpha1", "kind": "Location", "resourceRef": Object{"name": loc}},
				"reason": fmt.Sprintf("Project %s runs databases in this location; delete the Project first", s.name),
			},
		}}
	}

	s.status(out, statuses, bucket, ungranted, servers)
	return out
}

// cosiS3 is spec.secretS3 of the BucketInfo in a COSI Secret, nil without one.
func cosiS3(items []Object) Object {
	if len(items) == 0 {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(str(dig(items[0], "data", "BucketInfo")))
	if err != nil {
		return Object{}
	}
	var info Object
	if json.Unmarshal(raw, &info) != nil {
		return Object{}
	}
	return obj(dig(info, "spec", "secretS3"))
}

// inventory of the bucket's backup folders: the last status's entries
// (inactive unless still seen), updated from the PostgresClusters'
// ObjectStores that archive to this bucket.
func (s *settings) inventory(bucket Object, stores []Object) map[string]Object {
	servers := map[string]Object{}
	prev, _ := dig(s.xr, "status", "backup", "servers").([]any)
	for _, p := range prev {
		e, ok := p.(Object)
		if !ok {
			continue
		}
		entry := Object{}
		for k, v := range e {
			entry[k] = v
		}
		entry["active"] = false
		servers[str(e["serverName"])] = entry
	}
	name := str(bucket["bucket"])
	if name == "" {
		return servers
	}
	path := fmt.Sprintf("s3://%s/barman", name)
	for _, o := range stores {
		os, _ := dig(o, "status", "atProvider", "manifest").(Object)
		ann := obj(dig(os, "metadata", "annotations"))
		srv := str(ann["postgres.cndev.nl/server-name"])
		if srv == "" || str(dig(os, "spec", "configuration", "destinationPath")) != path {
			continue
		}
		e := servers[srv]
		if e == nil {
			e = Object{}
		}
		version, _ := strconv.Atoi(str(ann["postgres.cndev.nl/postgres-version"]))
		// New values win; empty ones keep what the last status had.
		for k, v := range map[string]any{
			"serverName": srv, "active": true,
			"cluster":         str(dig(o, "metadata", "labels", "postgres.cndev.nl/postgrescluster")),
			"location":        str(dig(o, "metadata", "annotations", "platform.cndev.nl/location")),
			"postgresVersion": version,
			"database":        str(ann["postgres.cndev.nl/database"]),
			"owner":           str(ann["postgres.cndev.nl/database-owner"]),
		} {
			if old, ok := e[k]; !ok || !empty(v) || empty(old) {
				e[k] = v
			}
		}
		window := obj(dig(os, "status", "serverRecoveryWindow", srv))
		if v := window["firstRecoverabilityPoint"]; !empty(v) {
			e["firstRecoverabilityPoint"] = v
		}
		if v := window["lastSuccessfulBackupTime"]; !empty(v) {
			e["lastSuccessfulBackup"] = v
		}
		servers[srv] = e
	}
	return servers
}

func (s *settings) status(out *Output, statuses []memberStatus, bucket Object, ungranted []string, servers map[string]Object) {
	var waiting, problems []string
	for _, st := range statuses {
		if st.problem != "" {
			problems = append(problems, st.problem)
		}
		if st.location == "local" {
			waiting = append(waiting, st.waiting...)
			continue
		}
		for _, w := range st.waiting {
			waiting = append(waiting, fmt.Sprintf("%s in %s", w, st.location))
		}
	}
	if bucket != nil && !boolOr(bucket["ready"], false) {
		waiting = append(waiting, "the backup bucket (COSI)")
	} else if len(ungranted) > 0 {
		waiting = append(waiting, fmt.Sprintf("COSI to grant backup bucket access in %s", strings.Join(ungranted, ", ")))
	}
	ready := len(waiting) == 0 && len(problems) == 0
	msg := fmt.Sprintf("Project %s is ready", s.name)
	switch {
	case len(problems) > 0:
		msg = strings.Join(problems, "; ")
	case !ready:
		msg = fmt.Sprintf("Waiting for %s", strings.Join(waiting, ", "))
	}
	if ready && s.hasRemote && s.promEnabled && s.rwURL == "" {
		msg = fmt.Sprintf("Project %s is ready; metrics stay in its locations and Grafana shows none (no prometheus.remoteWrite in project-defaults)", s.name)
	}
	if s.gov.expired {
		expiry := fmt.Sprintf("expired on %s: it keeps running, but nothing new can be created in it; extend spec.expiresAt or delete it", s.gov.expiresAt)
		if ready {
			msg = fmt.Sprintf("Project %s %s", s.name, expiry)
		} else {
			msg += "; " + expiry
		}
	}

	locations := []any{}
	var reach []any
	for _, st := range statuses[1:] {
		m := st.problem
		if m == "" {
			m = "ready"
			if len(st.waiting) > 0 {
				m = "waiting for " + strings.Join(st.waiting, ", ")
			}
		}
		locations = append(locations, Object{"location": st.location, "site": st.site,
			"ready": len(st.waiting) == 0 && st.problem == "", "message": m})
		if len(st.backupCheck) > 0 {
			r := Object{"location": st.location}
			for k, v := range st.backupCheck {
				r[k] = v
			}
			reach = append(reach, r)
		}
	}
	status := Object{"ready": ready, "message": msg, "namespace": s.ns, "locations": locations, "governance": s.gov.status()}
	if bucket != nil {
		b := Object{"ready": bucket["ready"], "namespace": bucket["namespace"]}
		if name := str(bucket["bucket"]); name != "" {
			b["bucket"], b["destinationPath"] = name, fmt.Sprintf("s3://%s/barman", name)
		}
		for _, k := range []string{"endpoint", "region"} {
			if v := str(bucket[k]); v != "" {
				b[k] = v
			}
		}
		if c := obj(bucket["credentials"]); len(c) > 0 {
			b["credentials"] = c
		}
		if len(reach) > 0 {
			b["reachability"] = reach
		}
		if len(servers) > 0 {
			keys := make([]string, 0, len(servers))
			for k := range servers {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			list := make([]any, 0, len(keys))
			for _, k := range keys {
				list = append(list, servers[k])
			}
			b["servers"] = list
		}
		status["backup"] = b
	}
	if s.promEnabled {
		p := Object{"url": fmt.Sprintf("http://prometheus-operated.%s.svc:9090", s.ns)}
		if s.rwURL != "" {
			p["remoteWriteUrl"] = s.rwURL
		}
		status["prometheus"] = p
	}
	if s.grafEnabled {
		g := Object{
			"internalUrl":      fmt.Sprintf("http://grafana-service.%s.svc:3000", s.ns),
			"adminSecret":      "grafana-admin-credentials",
			"instanceSelector": Object{"dashboards.paas.cndev.nl/scope": s.ns},
		}
		if s.host != "" {
			g["url"] = fmt.Sprintf("%s://%s", s.scheme, s.host)
		}
		status["grafana"] = g
	}
	out.Status = status
	reason := "Provisioning"
	if ready {
		reason = "Available"
	}
	out.Condition = Condition{Status: ready, Reason: reason, Message: msg}
}

// --- helpers

func (s *settings) labelsObj() Object {
	out := Object{}
	for k, v := range s.labels {
		out[k] = v
	}
	return out
}

func (s *settings) meta(name string) Object {
	return Object{"name": name, "namespace": s.ns, "labels": s.labelsObj()}
}

func dig(o any, path ...string) any {
	for _, p := range path {
		m, ok := o.(map[string]any)
		if !ok {
			return nil
		}
		if o, ok = m[p]; !ok {
			return nil
		}
	}
	return o
}

func obj(v any) Object {
	if m, ok := v.(Object); ok {
		return m
	}
	return Object{}
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func boolOr(v any, def bool) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return def
}

func or(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// empty is sprig's notion of an empty value, which its merge fills.
func empty(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	case bool:
		return !t
	case int:
		return t == 0
	case int64:
		return t == 0
	case float64:
		return t == 0
	}
	return false
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func sha1hex(s string) string {
	sum := sha1.Sum([]byte(s)) //nolint:gosec // see import
	return hex.EncodeToString(sum[:])
}

func sha256hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func conditionTrue(o Object, t string) bool {
	conds, _ := dig(o, "status", "conditions").([]any)
	for _, c := range conds {
		if m, ok := c.(Object); ok && m["type"] == t && m["status"] == "True" {
			return true
		}
	}
	return false
}
