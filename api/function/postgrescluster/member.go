package postgrescluster

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

const (
	barmanPlugin = "barman-cloud.cloudnative-pg.io"
	// The name every member's Cluster gives the restore source in externalClusters.
	restoreSource = "restore-source"
)

// member is what one location runs.
type member struct {
	location, site string
	// Name in the distributed topology, and the folder it archives to.
	topology string
	// Prefix of its composition resource names: "" or "recovery-".
	prefix string
	// The protected site: bootstraps the database (initdb or restore).
	original  bool
	instances int
	sizing    *Sizing

	// Observed objects in this location, keyed without the prefix.
	observed map[string]Object
	cluster  Object
	status   clusterStatus

	// spec.backup on the Project's bucket, or nil for spec.backup itself.
	backup *Backup
	// The restore this member bootstraps from (original member only).
	restore *memberRestore
	// Secret name here -> "<namespace>/<name>" to copy it from, else the
	// same name in the XR's namespace.
	copyFrom map[string]string

	placement MemberPlacement
}

type memberRestore struct {
	store      Store
	serverName string
	targetTime string
}

// emitted is one object of a member, before it is wrapped in an Object.
type emitted struct {
	manifest any
	ready    bool
	// Copy the Secret's data and type from "<namespace>/<name>" (Secrets only).
	copyFrom string
	// A backup folder of this cluster: the Project keeps an inventory of them.
	backupStore bool
}

// member renders everything one location runs, by composition resource name
// (without the member's prefix).
func (c *composition) member(m *member, members []*member, distributed bool) (map[string]emitted, error) {
	spec := c.spec
	name, ns := c.name, c.ns
	out := map[string]emitted{}
	meta := func(objName string) Meta {
		return Meta{Name: objName, Namespace: ns, Labels: c.labels}
	}
	exists := func(key string) bool { return m.observed[key] != nil }

	backup := spec.Backup
	if m.backup != nil {
		backup = *m.backup
	}
	db := spec.Database
	ha := spec.HighAvailability
	pooler := spec.Pooler
	mon := spec.Monitoring
	objectStoreName := name + "-backup"
	version := spec.postgresVersion()

	// ================= CloudNativePG Cluster =================
	// The size's tuned settings, under the ones spec.postgresql sets; what
	// the extensions in use need (postgres-extensions catalog) under both.
	params := map[string]string{}
	fillParams(params, spec.PostgreSQL.Parameters)
	fillParams(params, m.sizing.Parameters)
	for k, v := range c.extensions.parameters {
		if params[k] == "" {
			params[k] = v
		}
	}
	// Works around a CNPG instance-manager bug (v1.30.1): on a token
	// promotion the new postgresql.conf is written while the token is not
	// yet verified, that pass returns early and the reload is lost. The new
	// primary keeps its replica-cluster config hash, the operator waits for
	// uniform hashes and never rolls the pending restarts out. Changing a
	// placeholder GUC once lastPromotionToken is recorded makes every
	// instance rewrite and reload its config, unblocking the rollout.
	if t := m.status.LastPromotionToken; distributed && t != "" {
		sum := sha256.Sum256([]byte(t))
		params["basis.last_promotion"] = hex.EncodeToString(sum[:])[:16]
	}

	cs := ClusterSpec{
		Description: fmt.Sprintf("PostgresCluster %s/%s (postgres.cndev.nl)", ns, name),
		Instances:   m.instances,
		ImageCatalogRef: ImageCatalogRef{APIGroup: "postgresql.cnpg.io", Kind: "ClusterImageCatalog",
			Name: or(spec.ImageCatalog, "postgresql-standard-trixie"), Major: version},
		EnableSuperuserAccess: spec.EnableSuperuserAccess,
		PrimaryUpdateStrategy: or(ha.PrimaryUpdateStrategy, "unsupervised"),
		PrimaryUpdateMethod:   or(ha.PrimaryUpdateMethod, "switchover"),
		// Copied by CNPG onto every object it generates (pods, PVCs,
		// services, secrets): lets Prometheus relabelling and the
		// Backstage Kubernetes plugin find all of them.
		InheritedMetadata: InheritedMetadata{Labels: map[string]string{
			"postgres.cndev.nl/postgrescluster": name, "backstage.io/kubernetes-id": name}},
		Storage: VolumeSpec{Size: or(spec.Storage.Size, "10Gi"), StorageClass: spec.Storage.StorageClass},
		Affinity: ClusterAffinity{EnablePodAntiAffinity: true,
			PodAntiAffinityType: or(ha.PodAntiAffinityType, "preferred"), TopologyKey: "kubernetes.io/hostname"},
	}
	if w := spec.WALStorage; w != nil {
		cs.WALStorage = &VolumeSpec{Size: w.Size, StorageClass: w.StorageClass}
	}
	res := m.sizing.Resources
	cs.Resources = Resources{
		Requests: map[string]string{"cpu": str(digOr(res, "500m", "requests", "cpu")), "memory": str(digOr(res, "1Gi", "requests", "memory"))},
		Limits:   map[string]string{"memory": str(digOr(res, "1Gi", "limits", "memory"))},
	}
	if cpu := dig(res, "limits", "cpu"); truthy(cpu) {
		cs.Resources.Limits["cpu"] = str(cpu)
	}
	if orTrue(ha.ZoneSpread) {
		cs.TopologySpreadConstraints = []TopologySpreadConstraint{{
			MaxSkew: 1, TopologyKey: "topology.kubernetes.io/zone",
			// ScheduleAnyway: single-zone clusters keep working; the
			// CNPGClusterZoneSpreadWarning alert flags the imbalance.
			WhenUnsatisfiable: "ScheduleAnyway",
			LabelSelector:     LabelSelector{MatchLabels: map[string]string{"cnpg.io/cluster": name, "cnpg.io/podRole": "instance"}},
		}}
	}
	pg := spec.PostgreSQL
	images := m.imageExtensions(c.extensions)
	preload := m.preloadLibraries(pg.SharedPreloadLibraries, c.extensions, images)
	if len(params) > 0 || len(pg.PgHBA) > 0 || len(preload) > 0 || len(images) > 0 || ha.SynchronousReplicas > 0 {
		cs.PostgreSQL = &PostgresConfig{Parameters: params, PgHBA: pg.PgHBA, SharedPreloadLibraries: preload, Extensions: images}
		if n := ha.SynchronousReplicas; n > 0 {
			cs.PostgreSQL.Synchronous = &Synchronous{Method: "any", Number: n,
				DataDurability: or(ha.SynchronousDataDurability, "preferred")}
		}
	}
	switch {
	case m.restore != nil:
		// Point-in-time recovery from another cluster's backups
		// (spec.restore); the application owner's password is reset into
		// the <name>-app Secret.
		cs.Bootstrap.Recovery = &Recovery{Source: restoreSource, Database: db.name(), Owner: db.owner()}
		if t := m.restore.targetTime; t != "" {
			cs.Bootstrap.Recovery.RecoveryTarget = &RecoveryTarget{TargetTime: t}
		}
	case m.original:
		cs.Bootstrap.InitDB = &InitDB{Database: db.name(), Owner: db.owner(), Encoding: or(db.Encoding, "UTF8"),
			LocaleCollate: or(db.LocaleCollate, "C"), LocaleCType: or(db.LocaleCType, "C")}
	default:
		// A replica cluster starts from the original member's base backup
		// and WAL archive.
		cs.Bootstrap.Recovery = &Recovery{Source: members[0].topology}
	}
	if distributed {
		// Distributed topology: self/primary decide whether this member is
		// the primary or a replica cluster following source.
		p := m.placement
		cs.Replica = &ReplicaTopology{Self: m.topology, Primary: p.Primary, Source: p.Source, PromotionToken: p.PromotionToken}
		for _, o := range members {
			cs.ExternalClusters = append(cs.ExternalClusters, ExternalCluster{Name: o.topology, Plugin: PluginConfig{
				Name: barmanPlugin, Parameters: map[string]string{"barmanObjectName": objectStoreName, "serverName": o.topology}}})
		}
	}
	if r := m.restore; r != nil {
		cs.ExternalClusters = append(cs.ExternalClusters, ExternalCluster{Name: restoreSource, Plugin: PluginConfig{
			Name: barmanPlugin, Parameters: map[string]string{"barmanObjectName": name + "-restore", "serverName": r.serverName}}})
	}
	exposed := spec.Expose != nil && spec.Expose.Enabled
	if len(spec.Roles) > 0 || exposed {
		cs.Managed = &Managed{}
		for _, r := range spec.Roles {
			role := ManagedRole{Name: r.Name, Ensure: "present", Login: orTrue(r.Login), CreateDB: r.CreateDB,
				ConnectionLimit: -1, InRoles: r.InRoles}
			if r.ConnectionLimit != nil {
				role.ConnectionLimit = *r.ConnectionLimit
			}
			if r.PasswordSecret != "" {
				role.PasswordSecret = &Ref{Name: r.PasswordSecret}
			}
			cs.Managed.Roles = append(cs.Managed.Roles, role)
		}
		if e := spec.Expose; exposed {
			svc := ManagedService{SelectorType: "rw"}
			svc.ServiceTemplate.Metadata.Name = name + "-external"
			svc.ServiceTemplate.Metadata.Annotations = e.Annotations
			svc.ServiceTemplate.Spec.Type = or(e.Type, "LoadBalancer")
			svc.ServiceTemplate.Spec.LoadBalancerSourceRanges = e.LoadBalancerSourceRanges
			cs.Managed.Services = &ManagedServices{Additional: []ManagedService{svc}}
		}
	}
	if mon.enabled() {
		// Next to CNPG's default queries (the monitoring-queries ConfigMap).
		cs.Monitoring = &ClusterMonitoring{CustomQueriesConfigMap: []KeyRef{{Name: name + "-monitoring", Key: "queries"}}}
	}
	if backup.Enabled {
		p := ClusterPlugin{Name: barmanPlugin, IsWALArchiver: true, Parameters: map[string]string{"barmanObjectName": objectStoreName}}
		if m.topology != name {
			// Its own folder in the shared object store (a replica
			// cluster, or a restored cluster).
			p.Parameters["serverName"] = m.topology
		}
		cs.Plugins = []ClusterPlugin{p}
	}
	// A new Cluster waits for the ObjectStores its plugin reads: the Barman
	// Cloud plugin's pre-reconcile hook stops the Cluster's reconcile when it
	// finds none, and nothing wakes it again, so a Cluster created in the same
	// apply as its ObjectStore can stay unbootstrapped for good. One that was
	// composed before is always kept: its Object on the control plane counts,
	// not what the location reports (which is gone while it's unreachable),
	// or the Cluster would be deleted.
	storesReady := (!backup.Enabled || exists("objectstore")) && (m.restore == nil || exists("restore-objectstore"))
	if _, composed := c.observed[m.prefix+"cluster"]; storesReady || composed {
		out["cluster"] = emitted{ready: m.status.ready(), manifest: Cluster{APIVersion: "postgresql.cnpg.io/v1", Kind: "Cluster",
			Metadata: meta(name), Spec: cs}}
	}

	// ================= Backups: Barman Cloud ObjectStore + ScheduledBackup =================
	if backup.Enabled {
		os := ObjectStore{APIVersion: "barmancloud.cnpg.io/v1", Kind: "ObjectStore", Metadata: meta(objectStoreName),
			Spec: ObjectStoreSpec{RetentionPolicy: or(backup.RetentionPolicy, "30d"), Configuration: barmanStore(backup.Store)}}
		compression := or(backup.Compression, "gzip")
		os.Spec.Configuration.WAL = &WALBackup{Compression: compression, MaxParallel: 2}
		os.Spec.Configuration.Data = &DataBackup{Compression: compression, Jobs: 2}
		// What the Project's inventory of its bucket (status.backup.servers)
		// records about this folder, and keeps after the cluster is gone.
		os.Metadata.Annotations = map[string]string{
			"postgres.cndev.nl/server-name":      m.topology,
			"postgres.cndev.nl/postgres-version": fmt.Sprint(version),
			"postgres.cndev.nl/database":         db.name(),
			"postgres.cndev.nl/database-owner":   db.owner(),
		}
		out["objectstore"] = emitted{manifest: os, ready: exists("objectstore"), backupStore: true}

		sb := ScheduledBackup{APIVersion: "postgresql.cnpg.io/v1", Kind: "ScheduledBackup", Metadata: meta(name + "-scheduled"),
			Spec: ScheduledBackupSpec{Schedule: or(backup.Schedule, "0 0 2 * * *"),
				// Take the first base backup right away: WAL archiving alone
				// is not restorable until a base backup exists.
				Immediate: true, BackupOwnerReference: "self", Method: "plugin",
				PluginConfiguration: Ref{Name: barmanPlugin}, Cluster: Ref{Name: name}}}
		out["scheduled-backup"] = emitted{manifest: sb, ready: exists("scheduled-backup")}
	}

	// ================= Restore source: read-only ObjectStore =================
	if r := m.restore; r != nil {
		// No retentionPolicy: the source's backups are only read, never
		// pruned through this store.
		out["restore-objectstore"] = emitted{ready: exists("restore-objectstore"), manifest: ObjectStore{
			APIVersion: "barmancloud.cnpg.io/v1", Kind: "ObjectStore", Metadata: meta(name + "-restore"),
			Spec: ObjectStoreSpec{Configuration: barmanStore(r.store)}}}
	}

	// ================= Declarative databases =================
	database := func(dbName, owner, reclaim string, extensions []string) {
		key := "database-" + strings.ReplaceAll(dbName, "_", "-")
		d := DatabaseObject{APIVersion: "postgresql.cnpg.io/v1", Kind: "Database",
			Metadata: meta(name + "-" + strings.ReplaceAll(dbName, "_", "-")),
			Spec:     DatabaseSpec{Cluster: Ref{Name: name}, Name: dbName, Owner: owner, Ensure: "present", DatabaseReclaimPolicy: reclaim}}
		for _, e := range c.extensions.ordered(extensions) {
			d.Spec.Extensions = append(d.Spec.Extensions, DatabaseExtension{Name: e, Ensure: "present"})
		}
		// CNPG applies a Database only on the primary; a replica cluster
		// gets it through replication and waits until it is promoted.
		replica := distributed && m.placement.Role != RolePrimary
		out[key] = emitted{manifest: d, ready: replica || databaseApplied(m.observed[key])}
	}
	listed := false
	for _, d := range spec.Databases {
		database(d.Name, d.Owner, or(d.ReclaimPolicy, "retain"), d.Extensions)
		listed = listed || d.Name == db.name()
	}
	// The bootstrap database's extensions, unless a databases[] entry
	// manages that database. Never dropped: retain.
	if len(db.Extensions) > 0 && !listed {
		database(db.name(), db.owner(), "retain", db.Extensions)
	}

	// ================= PgBouncer poolers =================
	if pooler.Enabled {
		types := []string{"rw"}
		if pooler.ReadOnly {
			types = append(types, "ro")
		}
		for _, t := range types {
			p := PoolerObject{APIVersion: "postgresql.cnpg.io/v1", Kind: "Pooler", Metadata: meta(fmt.Sprintf("%s-pooler-%s", name, t))}
			p.Spec.Cluster = Ref{Name: name}
			p.Spec.Instances = or(pooler.Instances, 2)
			p.Spec.Type = t
			p.Spec.PgBouncer = PgBouncer{PoolMode: or(pooler.PoolMode, "transaction"), Parameters: map[string]string{
				"max_client_conn": fmt.Sprint(or(pooler.MaxClientConn, 1000)), "default_pool_size": fmt.Sprint(or(pooler.DefaultPoolSize, 25))}}
			p.Spec.Template.Metadata.Labels = map[string]string{"postgres.cndev.nl/postgrescluster": name, "backstage.io/kubernetes-id": name}
			p.Spec.Template.Spec.Containers = []any{}
			term := WeightedPodAffinityTerm{Weight: 100}
			term.PodAffinityTerm.TopologyKey = "kubernetes.io/hostname"
			term.PodAffinityTerm.LabelSelector.MatchLabels = map[string]string{"cnpg.io/poolerName": p.Metadata.Name}
			p.Spec.Template.Spec.Affinity.PodAntiAffinity.Preferred = []WeightedPodAffinityTerm{term}
			out["pooler-"+t] = emitted{manifest: p, ready: exists("pooler-" + t)}
		}
	}

	// ================= Prometheus metrics =================
	monLabels := map[string]string{}
	for k, v := range c.labels {
		monLabels[k] = v
	}
	for k, v := range mon.PodMonitorLabels {
		monLabels[k] = v
	}
	podMonitor := func(objName, role string) PodMonitor {
		pm := PodMonitor{APIVersion: "monitoring.coreos.com/v1", Kind: "PodMonitor",
			Metadata: Meta{Name: objName, Namespace: ns, Labels: monLabels}}
		pm.Spec.Selector.MatchLabels = map[string]string{"cnpg.io/cluster": name, "cnpg.io/podRole": role}
		pm.Spec.PodMetricsEndpoints = append(pm.Spec.PodMetricsEndpoints, struct {
			Port string `json:"port"`
		}{"metrics"})
		return pm
	}
	if mon.enabled() {
		// Replaces the deprecated Cluster.spec.monitoring.enablePodMonitor:
		// scrapes the CNPG exporter (port "metrics", 9187) on every instance.
		out["podmonitor"] = emitted{manifest: podMonitor(name, "instance"), ready: exists("podmonitor")}
		cmLabels := map[string]string{"cnpg.io/reload": ""} // CNPG reloads the queries when this ConfigMap changes.
		for k, v := range c.labels {
			cmLabels[k] = v
		}
		out["monitoring-queries"] = emitted{ready: exists("monitoring-queries"), manifest: ConfigMap{
			APIVersion: "v1", Kind: "ConfigMap", Metadata: Meta{Name: name + "-monitoring", Namespace: ns, Labels: cmLabels},
			Data: map[string]string{"queries": queriesFor(spec.profile())}}}
		if pooler.Enabled {
			// PgBouncer exporter (port "metrics", 9127) on every pooler pod.
			out["podmonitor-pooler"] = emitted{manifest: podMonitor(name+"-pooler", "pooler"), ready: exists("podmonitor-pooler")}
		}
	}
	if mon.rules() {
		pr := PrometheusRule{APIVersion: "monitoring.coreos.com/v1", Kind: "PrometheusRule",
			Metadata: Meta{Name: name + "-alerts", Namespace: ns, Labels: monLabels}}
		rules, err := alertRules(ns, name, mon.PrometheusRule.ExcludeRules)
		if err != nil {
			return nil, err
		}
		pr.Spec.Groups = []RuleGroup{{Name: fmt.Sprintf("cloudnative-pg/%s/%s", ns, name), Rules: rules}}
		out["prometheusrule"] = emitted{manifest: pr, ready: exists("prometheusrule")}
	}

	// ================= Secrets a remote location needs =================
	// The S3 credentials, endpoint CA and role passwords live in the XR's
	// namespace on the control plane. Their copies are Objects that patch
	// data/type from that Secret (provider-kubernetes references), so the
	// values never appear in the Object spec.
	copies := map[string]bool{}
	if backup.Enabled {
		if s := backup.S3Credentials; s != nil {
			copies[s.SecretName] = true
		}
		if s := backup.EndpointCA; s != nil {
			copies[s.SecretName] = true
		}
	}
	if r := m.restore; r != nil {
		if s := r.store.S3Credentials; s != nil {
			copies[s.SecretName] = true
		}
		if s := r.store.EndpointCA; s != nil {
			copies[s.SecretName] = true
		}
	}
	for _, r := range spec.Roles {
		if r.PasswordSecret != "" {
			copies[r.PasswordSecret] = true
		}
	}
	for secret := range copies {
		key := "secret-" + secret
		out[key] = emitted{manifest: Secret{APIVersion: "v1", Kind: "Secret", Metadata: meta(secret)},
			ready: exists(key), copyFrom: or(m.copyFrom[secret], secret)}
	}
	return out, nil
}

// barmanStore is the Barman Cloud configuration of a store.
func barmanStore(s Store) BarmanObjectStore {
	creds := s.S3Credentials
	if creds == nil {
		creds = &S3Credentials{}
	}
	b := BarmanObjectStore{DestinationPath: s.DestinationPath, EndpointURL: s.EndpointURL, S3Credentials: S3Keys{
		AccessKeyID:     KeyRef{Name: creds.SecretName, Key: or(creds.AccessKeyIDKey, "ACCESS_KEY_ID")},
		SecretAccessKey: KeyRef{Name: creds.SecretName, Key: or(creds.SecretAccessKeyKey, "ACCESS_SECRET_KEY")},
	}}
	if creds.RegionKey != "" {
		b.S3Credentials.Region = &KeyRef{Name: creds.SecretName, Key: creds.RegionKey}
	}
	if ca := s.EndpointCA; ca != nil {
		b.EndpointCA = &KeyRef{Name: ca.SecretName, Key: or(ca.Key, "ca.crt")}
	}
	return b
}

// wrap puts a member's object (composition resource name key) into a provider-kubernetes Object for the
// member's location.
func (c *composition) wrap(m *member, key string, e emitted) Composed {
	o := KubernetesObject{APIVersion: "kubernetes.m.crossplane.io/v1alpha1", Kind: "Object"}
	o.Metadata = Meta{Name: c.name + "-" + key, Namespace: c.ns, Labels: c.labels,
		Annotations: map[string]string{"platform.cndev.nl/location": m.location}}
	if e.backupStore {
		// The Project finds the backup folders in its bucket through this label.
		labels := map[string]string{"postgres.cndev.nl/backup-store": "true"}
		for k, v := range c.labels {
			labels[k] = v
		}
		o.Metadata.Labels = labels
	}
	o.Spec.ProviderConfigRef.Kind = "ClusterProviderConfig"
	o.Spec.ProviderConfigRef.Name = m.location
	o.Spec.Watch = true
	if from := e.copyFrom; from != "" {
		fromNS, fromName := c.ns, from
		if parts := strings.Split(from, "/"); len(parts) == 2 {
			fromNS, fromName = parts[0], parts[1]
		}
		for _, field := range []string{"data", "type"} {
			var r Reference
			r.PatchesFrom.APIVersion, r.PatchesFrom.Kind = "v1", "Secret"
			r.PatchesFrom.Name, r.PatchesFrom.Namespace, r.PatchesFrom.FieldPath = fromName, fromNS, field
			o.Spec.References = append(o.Spec.References, r)
		}
	}
	o.Spec.ForProvider.Manifest = toObject(e.manifest)
	return Composed{Object: o, Ready: e.ready}
}
