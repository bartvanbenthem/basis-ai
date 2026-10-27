package postgrescluster

import (
	"fmt"
	"strings"
)

// Status is the XR's status (definition.yaml status), mirrored from CNPG and
// carrying the pinned sites and backup store between reconciles.
type Status struct {
	Ready           bool              `json:"ready"`
	Phase           string            `json:"phase"`
	Instances       int               `json:"instances"`
	ReadyInstances  int               `json:"readyInstances"`
	CurrentPrimary  string            `json:"currentPrimary"`
	Image           string            `json:"image"`
	Message         string            `json:"message"`
	BackupStore     *BackupStore      `json:"backupStore,omitempty"`
	Sizing          *Sizing           `json:"sizing,omitempty"`
	Sites           *Sites            `json:"sites,omitempty"`
	PrimaryLocation string            `json:"primaryLocation,omitempty"`
	PrimarySite     string            `json:"primarySite,omitempty"`
	PromotionToken  string            `json:"promotionToken,omitempty"`
	Locations       []LocationStatus  `json:"locations"`
	Endpoints       Endpoints         `json:"endpoints"`
	Secrets         Secrets           `json:"secrets"`
	Backup          *BackupStatus     `json:"backup,omitempty"`
	Monitoring      *MonitoringStatus `json:"monitoring,omitempty"`
}

type Sites struct {
	Protected string `json:"protected"`
	Recovery  string `json:"recovery,omitempty"`
}

// BackupStore is the Project's bucket a cluster archives to.
type BackupStore struct {
	DestinationPath string `json:"destinationPath"`
	EndpointURL     string `json:"endpointURL"`
	// Where the Project's backup-s3-<location> Secrets are.
	Namespace string `json:"namespace"`
	// The credentials carry a REGION key.
	Region bool `json:"region"`
}

// Sizing is what the instances run with.
type Sizing struct {
	Resources  map[string]any `json:"resources"`
	Parameters map[string]any `json:"parameters"`
}

type LocationStatus struct {
	Location       string `json:"location"`
	Site           string `json:"site"`
	Role           Role   `json:"role"`
	Ready          bool   `json:"ready"`
	Phase          string `json:"phase"`
	Instances      int    `json:"instances"`
	ReadyInstances int    `json:"readyInstances"`
	CurrentPrimary string `json:"currentPrimary"`
}

type Endpoints struct {
	ReadWrite      string `json:"readWrite"`
	ReadOnly       string `json:"readOnly"`
	Read           string `json:"read"`
	Pooler         string `json:"pooler,omitempty"`
	PoolerReadOnly string `json:"poolerReadOnly,omitempty"`
}

type Secrets struct {
	App       string `json:"app"`
	Superuser string `json:"superuser,omitempty"`
}

type BackupStatus struct {
	ServerName               string `json:"serverName"`
	LastSuccessfulBackup     string `json:"lastSuccessfulBackup"`
	FirstRecoverabilityPoint string `json:"firstRecoverabilityPoint"`
}

type MonitoringStatus struct {
	DashboardUID string `json:"dashboardUid"`
}

type statusInput struct {
	members             []*member
	primary             *member
	placement           Placement
	protected, recovery string
	// Geo replication is off, the replica cluster stays until the primary is back.
	draining bool
	store    BackupStore
	sizing   *Sizing
	dashUID  string
}

func (c *composition) status(in statusInput) (Status, Condition) {
	spec := c.spec
	name, ns := c.name, c.ns
	p := in.placement
	cs := readClusterStatus(in.primary.cluster)

	ready := c.problem == ""
	var notReady []string
	for _, m := range in.members {
		if !m.status.ready() {
			ready = false
			notReady = append(notReady, m.location)
		}
	}
	phase := or(cs.Phase, "Provisioning")
	msg := fmt.Sprintf("Waiting for CNPG Cluster %s (phase: %s, %d/%d instances ready)", name, phase, cs.ReadyInstances, in.primary.instances)
	if ready {
		msg = fmt.Sprintf("CNPG Cluster %s is ready (%d/%d instances)", name, cs.ReadyInstances, in.primary.instances)
	}
	if len(in.members) > 1 {
		if ready {
			msg = fmt.Sprintf("CNPG Cluster %s is ready: primary in %s, %d replica cluster(s)", name, p.Current, len(in.members)-1)
		} else {
			msg = fmt.Sprintf("Waiting for CNPG Cluster %s in %s", name, strings.Join(notReady, ", "))
		}
		switch {
		case p.Waiting:
			msg = fmt.Sprintf("Switching the primary from %s to %s: waiting for the demotion token of %s", p.Prev, p.Target, p.Prev)
		case in.draining:
			msg = fmt.Sprintf("geoReplication is off: switching the primary back to %s before removing the replica cluster in %s", in.protected, in.recovery)
		}
	}
	// Until an instance is up, a restored cluster is still recovering.
	if r := spec.Restore; r != nil && !ready && cs.ReadyInstances == 0 && len(in.members) > 0 {
		upTo := "latest state"
		if r.TargetTime != "" {
			upTo = "up to " + r.TargetTime
		}
		msg = fmt.Sprintf("Restoring %s from backup folder %s (%s); phase: %s", name, r.Source.ServerName, upTo, phase)
	}
	if c.problem != "" {
		msg = c.problem
	}

	s := Status{
		Ready: ready, Phase: phase, Instances: cs.Instances, ReadyInstances: cs.ReadyInstances,
		CurrentPrimary: cs.CurrentPrimary, Image: cs.Image, Message: msg,
		Sizing:         in.sizing,
		PromotionToken: p.Token,
		Locations:      []LocationStatus{},
		Endpoints: Endpoints{
			ReadWrite: fmt.Sprintf("%s-rw.%s.svc", name, ns),
			ReadOnly:  fmt.Sprintf("%s-ro.%s.svc", name, ns),
			Read:      fmt.Sprintf("%s-r.%s.svc", name, ns),
		},
		Secrets: Secrets{App: name + "-app"},
	}
	if in.store.DestinationPath != "" {
		store := in.store
		s.BackupStore = &store
	}
	if in.protected != "" {
		s.Sites = &Sites{Protected: in.protected, Recovery: in.recovery}
		s.PrimaryLocation = p.Current
		s.PrimarySite = "protected"
		if in.recovery != "" && p.Current == in.recovery {
			s.PrimarySite = "recovery"
		}
	}
	for _, m := range in.members {
		s.Locations = append(s.Locations, LocationStatus{
			Location: m.location, Site: m.site, Role: m.placement.Role, Ready: m.status.ready(),
			Phase: or(m.status.Phase, "Provisioning"), Instances: m.instances,
			ReadyInstances: m.status.ReadyInstances, CurrentPrimary: m.status.CurrentPrimary,
		})
	}
	if spec.Pooler.Enabled {
		s.Endpoints.Pooler = fmt.Sprintf("%s-pooler-rw.%s.svc", name, ns)
		if spec.Pooler.ReadOnly {
			s.Endpoints.PoolerReadOnly = fmt.Sprintf("%s-pooler-ro.%s.svc", name, ns)
		}
	}
	if spec.EnableSuperuserAccess {
		s.Secrets.Superuser = name + "-superuser"
	}
	if spec.Backup.Enabled {
		w := readRecoveryWindow(in.primary.observed["objectstore"], in.primary.topology)
		s.Backup = &BackupStatus{ServerName: in.primary.topology,
			LastSuccessfulBackup: w.LastSuccessfulBackupTime, FirstRecoverabilityPoint: w.FirstRecoverabilityPoint}
	}
	if spec.Monitoring.dashboard() {
		s.Monitoring = &MonitoringStatus{DashboardUID: in.dashUID}
	}

	cond := Condition{Status: ready, Reason: "ClusterHealthy", Message: msg}
	switch {
	case ready:
	case c.problem != "":
		cond.Reason = "NoSite"
	default:
		cond.Reason = "ClusterNotReady"
	}
	return s, cond
}

// dashboard is CloudNativePG's official Grafana dashboard (Apache-2.0) for
// this cluster: its own title and uid, the namespace/cluster variables preset.
func (c *composition) dashboard(uid string) GrafanaDashboard {
	g := c.spec.Monitoring.GrafanaDashboard
	d := GrafanaDashboard{APIVersion: "grafana.integreatly.org/v1beta1", Kind: "GrafanaDashboard",
		Metadata: Meta{Name: c.name + "-cnpg", Namespace: c.ns, Labels: c.labels}}
	d.Spec.InstanceSelector.MatchLabels = g.InstanceSelector
	if len(g.InstanceSelector) == 0 {
		d.Spec.InstanceSelector.MatchLabels = map[string]string{"dashboards.paas.cndev.nl/scope": c.ns}
	}
	d.Spec.AllowCrossNamespaceImport = g.AllowCrossNamespaceImport
	d.Spec.Folder = or(g.Folder, "CloudNativePG")
	d.Spec.UID = uid
	d.Spec.ResyncPeriod = "10m"
	d.Spec.Datasources = append(d.Spec.Datasources, struct {
		InputName      string `json:"inputName"`
		DatasourceName string `json:"datasourceName"`
	}{"DS_PROMETHEUS", or(g.DatasourceName, "prometheus")})
	d.Spec.JSON = dashboardJSON(c.ns, c.name, uid)
	return d
}
