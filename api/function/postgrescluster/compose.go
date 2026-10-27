// Package postgrescluster composes a PostgresCluster
// (postgres.cndev.nl/v1alpha1).
//
// The namespaced XR lives in its Project's namespace on the control plane,
// which runs no databases. The CNPG and Prometheus Operator objects go to the
// Project's locations, each wrapped in a provider-kubernetes Object; only the
// GrafanaDashboard is composed directly (the project's Grafana runs on the
// control plane).
//
// Readiness: every composed resource reports its readiness explicitly
// (non-managed resources have no generic Ready signal), so the XR's own Ready
// condition means "Cluster healthy + every extra object exists".
//
// Sites: the Project (a required resource, named after the namespace) has a
// protected location and optionally a recovery location (spec.locations).
// The XR pins them in status.sites on first use, so a cluster never moves,
// and a missing Project never empties the composition.
//
// Members: a member is what one location runs (Cluster, backups, databases,
// poolers, monitors). The protected site is the member with resource-name
// prefix "", the recovery site (spec.geoReplication) the member with prefix
// "recovery-". Every object is wrapped in a provider-kubernetes Object for
// the ClusterProviderConfig named after the location. See topology.go for
// how the primary moves between them.
//
// Backups without backup.destinationPath go to the Project's backup bucket
// (COSI, Project status.backup): every member archives there with the
// credentials the Project unpacked for its location (Secret
// backup-s3-<location> in the project namespace), copied to the location as
// <name>-backup-s3. The bucket is pinned in status.backupStore on first use.
//
// Restore (spec.restore, only at creation): the protected site's Cluster
// bootstraps with recovery from another cluster's backup folder, through a
// read-only ObjectStore <name>-restore (no retentionPolicy: nothing is ever
// deleted through it). The restored cluster archives to a folder of its own,
// <name>-<uid[:8]>, so it never writes into the source's folder, not even when
// it takes the name of a deleted cluster. Its replica cluster's folder is
// <that>-<recovery location>.
//
// Resources (spec.resources): each instance's CPU and memory (500m/1Gi
// unset), with postgresql.conf settings tuned to them under the ones
// spec.postgresql.parameters sets; status.sizing shows the result. Changing
// them restarts the instances one by one, the primary last.
//
// Extensions (spec.database.extensions, spec.databases[].extensions): the
// EnvironmentConfig "postgres-extensions" (data.extensions, a list of {name,
// parameters, sharedPreloadLibraries, image, ...}) is what the admission
// policy lets clusters add. The parameters of the extensions in use go under
// the tuned ones and spec's, their libraries are preloaded, and one with
// an image (PostgreSQL 18+) is mounted from it (CNPG image volume
// extensions); see extensions.go. The bootstrap database gets a CNPG Database
// of its own (databaseReclaimPolicy retain) for its extensions.
//
// Profiles (spec.profile): general, or vector for embeddings and hybrid
// search. Vector tunes for building indexes in memory (see tuned) and
// exports metrics on the vector indexes.
package postgrescluster

import (
	"crypto/sha1" //nolint:gosec // a dashboard uid, not a security boundary
	"encoding/hex"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// The resources the composition reads besides the XR, by requirement name.
const (
	RequiredProject    = "project"
	RequiredExtensions = "extensions"
)

// Requirement is a resource the composition needs to see.
type Requirement struct {
	APIVersion, Kind, Name string
}

// Requirements returns what Compose reads besides the XR: the Project named
// after the XR's namespace and the extensions catalog.
func Requirements(namespace string) map[string]Requirement {
	return map[string]Requirement{
		RequiredProject:    {"platform.cndev.nl/v1alpha1", "Project", namespace},
		RequiredExtensions: {"apiextensions.crossplane.io/v1beta1", "EnvironmentConfig", "postgres-extensions"},
	}
}

// Input is one reconcile's view.
type Input struct {
	// XR is the observed PostgresCluster.
	XR Object
	// Observed composed resources, by composition resource name.
	Observed map[string]Object
	// Required resources, by requirement name. A name is present once
	// Crossplane has resolved it (with no items if nothing matched).
	Required map[string][]Object
}

// Composed is a desired composed resource.
type Composed struct {
	Object any // a manifest struct from manifests.go, or an Object
	Ready  bool
}

// Condition is the PostgresReady condition on the XR.
type Condition struct {
	Status  bool
	Reason  string
	Message string
}

// Output is the desired state.
type Output struct {
	Composed  map[string]Composed
	Status    Status
	Condition Condition
}

// Stop errors are refusals: never render a desired state that would tear
// down or reconfigure a running database because an input went missing.
type Stop struct{ msg string }

func (e *Stop) Error() string { return e.msg }

func stop(format string, args ...any) error { return &Stop{fmt.Sprintf(format, args...)} }

// composition is one reconcile in progress.
type composition struct {
	xr         XR
	spec       *Spec
	name, ns   string
	observed   map[string]Object // raw, as observed
	live       map[string]Object // normalised, see live()
	required   map[string][]Object
	project    Object
	problem    string
	labels     map[string]string
	extensions extensionConfig // what the extensions in use need
}

// Compose renders the desired state of a PostgresCluster.
func Compose(in Input) (*Output, error) {
	c := &composition{observed: in.Observed, live: live(in.Observed), required: in.Required}
	decode(in.XR, &c.xr)
	c.spec = &c.xr.Spec
	c.name, c.ns = c.xr.Metadata.Name, c.xr.Metadata.Namespace
	c.labels = map[string]string{
		"app.kubernetes.io/managed-by":      "crossplane",
		"app.kubernetes.io/part-of":         "basis",
		"postgres.cndev.nl/postgrescluster": c.name,
	}
	if projects := in.Required[RequiredProject]; len(projects) > 0 {
		c.project = projects[0]
	}
	return c.compose()
}

func (c *composition) resolved(requirement string) bool {
	_, ok := c.required[requirement]
	return ok
}

// running reports whether the XR already composes more than the dashboard,
// i.e. there may be a database to protect.
func (c *composition) running() bool { return len(c.observed) > 1 }

func (c *composition) setProblem(format string, args ...any) {
	if c.problem == "" {
		c.problem = fmt.Sprintf(format, args...)
	}
}

func (c *composition) compose() (*Output, error) {
	spec := c.spec

	// ---- sites: pinned in status.sites, else the Project's spec.locations
	var projectSites Sites
	decode(dig(c.project, "spec", "locations"), &projectSites)
	protected := or(c.xr.Status.Sites.Protected, projectSites.Protected)
	recovery := or(c.xr.Status.Sites.Recovery, projectSites.Recovery)
	geo := spec.GeoReplication
	// Geo replication switched off while the primary is in the recovery
	// site: keep the replica cluster and switch back first.
	draining := !geo.Enabled && recovery != "" && c.xr.Status.PrimaryLocation == recovery
	switch {
	case protected == "":
		if c.resolved(RequiredProject) && c.running() {
			return nil, stop("PostgresCluster %s/%s has composed resources but no site: neither status.sites nor Project %s says where it runs", c.ns, c.name, c.ns)
		}
		c.setProblem("Namespace %s is not a Project with a protected location (Project spec.locations.protected)", c.ns)
	case geo.Enabled && recovery == "":
		c.setProblem("geoReplication is enabled, but Project %s has no recovery location (spec.locations.recovery)", c.ns)
	}

	// ---- backup store: the cluster's own, or the Project's bucket (pinned in status.backupStore)
	projectBucket := spec.Backup.Enabled && spec.Backup.DestinationPath == ""
	restore := spec.Restore
	restoreFromProject := restore != nil && restore.Source.DestinationPath == ""
	var store BackupStore
	if projectBucket || restoreFromProject {
		if s := c.xr.Status.BackupStore; s != nil {
			store = *s
		}
		var pbs struct {
			Ready           bool   `json:"ready"`
			DestinationPath string `json:"destinationPath"`
			Endpoint        string `json:"endpoint"`
			Namespace       string `json:"namespace"`
			Region          string `json:"region"`
		}
		decode(dig(c.project, "status", "backup"), &pbs)
		if store.DestinationPath == "" && pbs.Ready && pbs.DestinationPath != "" {
			store = BackupStore{DestinationPath: pbs.DestinationPath, EndpointURL: pbs.Endpoint,
				Namespace: or(pbs.Namespace, c.ns), Region: pbs.Region != ""}
		}
		if store.DestinationPath == "" {
			// Never drop WAL archiving from a running cluster.
			if c.resolved(RequiredProject) && c.running() {
				return nil, stop("PostgresCluster %s/%s uses the Project's backup bucket, but neither status.backupStore nor Project %s status.backup says which", c.ns, c.name, c.ns)
			}
			verb := "restore reads from"
			if projectBucket {
				verb = "backup uses"
			}
			c.setProblem("%s the backup bucket of Project %s, which isn't ready (Project spec.backup and COSI)", verb, c.ns)
		}
	}

	sizing := c.sizing()
	c.extensions = c.resolveExtensions()

	// ---- archive folders: the cluster's name, or a new one for a restored
	// cluster (never the folder it restores from)
	server := c.name
	if restore != nil {
		server = fmt.Sprintf("%s-%s", c.name, truncate(or(c.xr.Metadata.UID, "restored"), 8))
	}

	// ---- members: the protected site, then the recovery site
	var members []*member
	if protected != "" && (!(projectBucket || restoreFromProject) || store.DestinationPath != "") {
		members = append(members, &member{location: protected, site: "protected", topology: server, prefix: "",
			original: true, instances: spec.instances(), sizing: sizing})
		if recovery != "" && (geo.Enabled || draining) {
			members = append(members, &member{location: recovery, site: "recovery",
				topology: fmt.Sprintf("%s-%s", server, recovery), prefix: "recovery-",
				instances: or(geo.Instances, spec.instances()), sizing: sizing})
		}
	}
	distributed := len(members) > 1
	// The Project's bucket as every member reaches it: through its copy of
	// the credentials, <name>-backup-s3.
	var bucket Store
	if store.DestinationPath != "" {
		bucket = Store{DestinationPath: store.DestinationPath, EndpointURL: store.EndpointURL,
			S3Credentials: &S3Credentials{SecretName: c.name + "-backup-s3"}}
		if store.Region {
			bucket.S3Credentials.RegionKey = "REGION"
		}
	}
	byLocation := map[string]*member{}
	for _, m := range members {
		m.observed = map[string]Object{}
		for k, v := range c.live {
			switch {
			case m.original && !strings.HasPrefix(k, "recovery-"):
				m.observed[k] = v
			case !m.original && strings.HasPrefix(k, m.prefix):
				m.observed[strings.TrimPrefix(k, m.prefix)] = v
			}
		}
		m.cluster = m.observed["cluster"]
		m.status = readClusterStatus(m.cluster)
		byLocation[m.location] = m

		if store.DestinationPath != "" {
			if projectBucket {
				// The cluster's own settings (retention, schedule, ...) on the Project's bucket.
				backup := spec.Backup
				backup.DestinationPath, backup.S3Credentials = bucket.DestinationPath, bucket.S3Credentials
				backup.EndpointURL = or(bucket.EndpointURL, backup.EndpointURL)
				m.backup = &backup
			}
			// Each location gets the credentials the Project unpacked for it.
			m.copyFrom = map[string]string{bucket.S3Credentials.SecretName: fmt.Sprintf("%s/backup-s3-%s", store.Namespace, m.location)}
		}
		if restore != nil && m.original {
			src := restore.Source.Store
			if restoreFromProject {
				src = bucket
			}
			m.restore = &memberRestore{store: src, serverName: restore.Source.ServerName, targetTime: restore.TargetTime}
		}
	}

	// ---- which member is primary
	target := protected
	if or(geo.PrimarySite, "protected") == "recovery" && geo.Enabled && byLocation[recovery] != nil {
		target = recovery
	}
	prev := or(c.xr.Status.PrimaryLocation, protected)
	if byLocation[prev] == nil {
		prev = protected
	}
	tms := make([]topologyMember, len(members))
	for i, m := range members {
		tms[i] = topologyMember{Location: m.location, Topology: m.topology, Status: m.status}
	}
	placement := place(tms, target, prev, or(geo.Promotion, Switchover), c.xr.Status.PromotionToken)
	for _, m := range members {
		m.placement = placement.Members[m.location]
	}

	// ---- emit every member's objects, then the dashboard
	out := &Output{Composed: map[string]Composed{}}
	for _, m := range members {
		objs, err := c.member(m, members, distributed)
		if err != nil {
			return nil, err
		}
		for key, obj := range objs {
			out.Composed[m.prefix+key] = c.wrap(m, m.prefix+key, obj)
		}
	}
	dashUID := "cnpg-" + truncate(sha1hex(c.ns+"/"+c.name), 20)
	if spec.Monitoring.dashboard() {
		out.Composed["dashboard"] = Composed{Object: c.dashboard(dashUID), Ready: c.observed["dashboard"] != nil}
	}

	primary := byLocation[placement.Current]
	if primary == nil {
		primary = &member{instances: spec.instances(), topology: server, observed: map[string]Object{}}
	}
	out.Status, out.Condition = c.status(statusInput{
		members: members, primary: primary, placement: placement, protected: protected, recovery: recovery,
		draining: draining && distributed, store: store, sizing: sizing, dashUID: dashUID,
	})
	return out, nil
}

// sizing resolves spec.resources into what the instances run with: memory
// as request and limit (Guaranteed QoS, the memory the settings assume), no
// CPU limit so instances aren't throttled, and postgresql.conf tuned to them.
func (c *composition) sizing() *Sizing {
	cpu, memory := c.spec.cpu(), c.spec.memory()
	return &Sizing{
		Resources: map[string]any{
			"requests": map[string]any{"cpu": cpu, "memory": memory},
			"limits":   map[string]any{"memory": memory},
		},
		Parameters: tuned(cpu, memory, c.spec.profile()),
	}
}

// tuned is postgresql.conf for an instance's CPU and memory: shared_buffers
// 25% of the memory, effective_cache_size 75%, and connections and work
// memory that grow with it. The vector profile builds HNSW and VectorChord
// indexes in memory: maintenance_work_mem ~20% (they build fastest with room)
// and parallel workers for it, up to the CPUs. spec.postgresql.parameters wins
// over these.
func tuned(cpu, memory, profile string) map[string]any {
	mb := mebibytes(memory)
	connections := 400
	switch {
	case mb < 4096:
		connections = 100
	case mb < 16384:
		connections = 200
	case mb < 32768:
		connections = 300
	}
	p := map[string]any{
		"max_connections":      strconv.Itoa(connections),
		"shared_buffers":       pgMB(mb / 4),
		"effective_cache_size": pgMB(mb * 3 / 4),
		"work_mem":             pgMB(max(mb/512, 4)),
		"maintenance_work_mem": pgMB(max(mb/16, 64)),
	}
	if profile == ProfileVector {
		p["maintenance_work_mem"] = pgMB(max(mb*3/16, 64))
		workers := int64(max(math.Ceil(cores(cpu)*0.75), 1))
		p["max_parallel_maintenance_workers"] = strconv.FormatInt(workers, 10)
	}
	return p
}

// mebibytes is a Kubernetes memory quantity (Mi or Gi) in MiB.
func mebibytes(memory string) int64 {
	if n, ok := strings.CutSuffix(memory, "Gi"); ok {
		v, _ := strconv.ParseInt(n, 10, 64)
		return v * 1024
	}
	v, _ := strconv.ParseInt(strings.TrimSuffix(memory, "Mi"), 10, 64)
	return v
}

// cores is a Kubernetes CPU quantity in cores.
func cores(cpu string) float64 {
	if m, ok := strings.CutSuffix(cpu, "m"); ok {
		v, _ := strconv.ParseFloat(m, 64)
		return v / 1000
	}
	v, _ := strconv.ParseFloat(cpu, 64)
	return v
}

// pgMB is MiB as a postgresql.conf size: GB when whole.
func pgMB(mb int64) string {
	if mb > 0 && mb%1024 == 0 {
		return fmt.Sprintf("%dGB", mb/1024)
	}
	return fmt.Sprintf("%dMB", mb)
}

// fillParams sets the settings dst doesn't have (or has empty) from src.
func fillParams(dst map[string]string, src map[string]any) {
	for k, v := range src {
		if dst[k] == "" {
			dst[k] = str(v)
		}
	}
}

// --- small helpers

// str formats a scalar from JSON the way the manifests carry it (quoted).
func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprint(int64(x))
		}
	}
	return fmt.Sprint(v)
}

// digOr is dig with a default for a missing value.
func digOr(obj any, def any, path ...string) any {
	if v := dig(obj, path...); v != nil {
		return v
	}
	return def
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case bool:
		return x
	case float64:
		return x != 0
	case int64:
		return x != 0
	}
	return true
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func sha1hex(s string) string {
	sum := sha1.Sum([]byte(s)) //nolint:gosec // see import
	return hex.EncodeToString(sum[:])
}
