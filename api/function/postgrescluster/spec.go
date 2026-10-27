package postgrescluster

// The PostgresCluster XR, as far as the composition reads it. Fields mirror
// apis/postgrescluster/definition.yaml. The API server applies the XRD
// defaults; the accessors below apply them again so `crossplane render` and
// objects created before a default existed come out the same.

// XR is the observed PostgresCluster.
type XR struct {
	Metadata struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
		UID       string `json:"uid"`
	} `json:"metadata"`
	Spec   Spec     `json:"spec"`
	Status XRStatus `json:"status"`
}

// XRStatus is the part of the XR's own status the composition carries
// between reconciles (pinned on first use).
type XRStatus struct {
	Sites           Sites        `json:"sites"`
	PrimaryLocation string       `json:"primaryLocation"`
	PromotionToken  string       `json:"promotionToken"`
	BackupStore     *BackupStore `json:"backupStore"`
}

type Spec struct {
	Restore               *Restore          `json:"restore"`
	GeoReplication        GeoReplication    `json:"geoReplication"`
	PostgresVersion       int               `json:"postgresVersion"`
	ImageCatalog          string            `json:"imageCatalog"`
	Profile               string            `json:"profile"`
	Instances             int               `json:"instances"`
	Storage               Storage           `json:"storage"`
	WALStorage            *Storage          `json:"walStorage"`
	Resources             InstanceResources `json:"resources"`
	PostgreSQL            PostgreSQL        `json:"postgresql"`
	Database              Database          `json:"database"`
	Databases             []ExtraDatabase   `json:"databases"`
	Roles                 []DatabaseRole    `json:"roles"`
	EnableSuperuserAccess bool              `json:"enableSuperuserAccess"`
	HighAvailability      HighAvailability  `json:"highAvailability"`
	Pooler                Pooler            `json:"pooler"`
	Backup                Backup            `json:"backup"`
	Monitoring            Monitoring        `json:"monitoring"`
	Expose                *Expose           `json:"expose"`
}

type Restore struct {
	Source     RestoreSource `json:"source"`
	TargetTime string        `json:"targetTime"`
}

type RestoreSource struct {
	ServerName string `json:"serverName"`
	Store
}

// Store is an S3 prefix and how to reach it: spec.backup, restore.source, or
// the Project's bucket.
type Store struct {
	DestinationPath string         `json:"destinationPath"`
	EndpointURL     string         `json:"endpointURL"`
	EndpointCA      *SecretKey     `json:"endpointCA"`
	S3Credentials   *S3Credentials `json:"s3Credentials"`
}

type SecretKey struct {
	SecretName string `json:"secretName"`
	Key        string `json:"key"`
}

type S3Credentials struct {
	SecretName         string `json:"secretName"`
	AccessKeyIDKey     string `json:"accessKeyIdKey"`
	SecretAccessKeyKey string `json:"secretAccessKeyKey"`
	RegionKey          string `json:"regionKey"`
}

type GeoReplication struct {
	Enabled     bool   `json:"enabled"`
	Instances   int    `json:"instances"`
	PrimarySite string `json:"primarySite"`
	Promotion   string `json:"promotion"`
}

// InstanceResources are each instance's CPU and memory; memory is request and limit.
type InstanceResources struct {
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
}

type Storage struct {
	Size         string `json:"size"`
	StorageClass string `json:"storageClass"`
}

type PostgreSQL struct {
	Parameters             map[string]any `json:"parameters"`
	PgHBA                  []string       `json:"pgHba"`
	SharedPreloadLibraries []string       `json:"sharedPreloadLibraries"`
}

type Database struct {
	Name          string   `json:"name"`
	Owner         string   `json:"owner"`
	Encoding      string   `json:"encoding"`
	LocaleCollate string   `json:"localeCollate"`
	LocaleCType   string   `json:"localeCType"`
	Extensions    []string `json:"extensions"`
}

type ExtraDatabase struct {
	Name          string   `json:"name"`
	Owner         string   `json:"owner"`
	Extensions    []string `json:"extensions"`
	ReclaimPolicy string   `json:"reclaimPolicy"`
}

type DatabaseRole struct {
	Name            string   `json:"name"`
	Login           *bool    `json:"login"`
	CreateDB        bool     `json:"createdb"`
	InRoles         []string `json:"inRoles"`
	PasswordSecret  string   `json:"passwordSecret"`
	ConnectionLimit *int     `json:"connectionLimit"`
}

type HighAvailability struct {
	PodAntiAffinityType       string `json:"podAntiAffinityType"`
	ZoneSpread                *bool  `json:"zoneSpread"`
	SynchronousReplicas       int    `json:"synchronousReplicas"`
	SynchronousDataDurability string `json:"synchronousDataDurability"`
	PrimaryUpdateMethod       string `json:"primaryUpdateMethod"`
	PrimaryUpdateStrategy     string `json:"primaryUpdateStrategy"`
}

type Pooler struct {
	Enabled         bool   `json:"enabled"`
	Instances       int    `json:"instances"`
	PoolMode        string `json:"poolMode"`
	MaxClientConn   int    `json:"maxClientConn"`
	DefaultPoolSize int    `json:"defaultPoolSize"`
	ReadOnly        bool   `json:"readOnly"`
}

type Backup struct {
	Enabled         bool   `json:"enabled"`
	RetentionPolicy string `json:"retentionPolicy"`
	Schedule        string `json:"schedule"`
	Compression     string `json:"compression"`
	Store
}

type Monitoring struct {
	Enabled          *bool             `json:"enabled"`
	PodMonitorLabels map[string]string `json:"podMonitorLabels"`
	PrometheusRule   struct {
		Enabled      *bool    `json:"enabled"`
		ExcludeRules []string `json:"excludeRules"`
	} `json:"prometheusRule"`
	GrafanaDashboard struct {
		Enabled                   *bool             `json:"enabled"`
		InstanceSelector          map[string]string `json:"instanceSelector"`
		AllowCrossNamespaceImport bool              `json:"allowCrossNamespaceImport"`
		Folder                    string            `json:"folder"`
		DatasourceName            string            `json:"datasourceName"`
	} `json:"grafanaDashboard"`
}

type Expose struct {
	Enabled                  bool              `json:"enabled"`
	Type                     string            `json:"type"`
	Annotations              map[string]string `json:"annotations"`
	LoadBalancerSourceRanges []string          `json:"loadBalancerSourceRanges"`
}

// --- defaults

func or[T comparable](v, def T) T {
	var zero T
	if v == zero {
		return def
	}
	return v
}

func orTrue(b *bool) bool { return b == nil || *b }

func (s *Spec) postgresVersion() int  { return or(s.PostgresVersion, 17) }
func (s *Spec) instances() int        { return or(s.Instances, 3) }
func (s *Spec) profile() string       { return or(s.Profile, ProfileGeneral) }
func (s *Spec) cpu() string           { return or(s.Resources.CPU, "500m") }
func (s *Spec) memory() string        { return or(s.Resources.Memory, "1Gi") }
func (d *Database) name() string      { return or(d.Name, "app") }
func (d *Database) owner() string     { return or(d.Owner, "app") }
func (m *Monitoring) enabled() bool   { return orTrue(m.Enabled) }
func (m *Monitoring) rules() bool     { return m.enabled() && orTrue(m.PrometheusRule.Enabled) }
func (m *Monitoring) dashboard() bool { return orTrue(m.GrafanaDashboard.Enabled) }
