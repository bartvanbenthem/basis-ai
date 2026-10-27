package postgrescluster

// The objects the composition emits. Only the fields it sets, so what reaches
// a location is exactly what the composition means: the upstream CNPG,
// Barman Cloud and Prometheus Operator Go types serialise defaulted and empty
// fields (status, syncReplicaElectionConstraint, ...) that provider-kubernetes
// would then apply to every running cluster.

type Meta struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
}

type Ref struct {
	Name string `json:"name"`
}

type KeyRef struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

// --- postgresql.cnpg.io/v1 Cluster

type Cluster struct {
	APIVersion string      `json:"apiVersion"`
	Kind       string      `json:"kind"`
	Metadata   Meta        `json:"metadata"`
	Spec       ClusterSpec `json:"spec"`
}

type ClusterSpec struct {
	Description               string                     `json:"description"`
	Instances                 int                        `json:"instances"`
	ImageCatalogRef           ImageCatalogRef            `json:"imageCatalogRef"`
	EnableSuperuserAccess     bool                       `json:"enableSuperuserAccess"`
	PrimaryUpdateStrategy     string                     `json:"primaryUpdateStrategy"`
	PrimaryUpdateMethod       string                     `json:"primaryUpdateMethod"`
	InheritedMetadata         InheritedMetadata          `json:"inheritedMetadata"`
	Storage                   VolumeSpec                 `json:"storage"`
	WALStorage                *VolumeSpec                `json:"walStorage,omitempty"`
	Resources                 Resources                  `json:"resources"`
	Affinity                  ClusterAffinity            `json:"affinity"`
	TopologySpreadConstraints []TopologySpreadConstraint `json:"topologySpreadConstraints,omitempty"`
	PostgreSQL                *PostgresConfig            `json:"postgresql,omitempty"`
	Bootstrap                 Bootstrap                  `json:"bootstrap"`
	Replica                   *ReplicaTopology           `json:"replica,omitempty"`
	ExternalClusters          []ExternalCluster          `json:"externalClusters,omitempty"`
	Managed                   *Managed                   `json:"managed,omitempty"`
	Monitoring                *ClusterMonitoring         `json:"monitoring,omitempty"`
	Plugins                   []ClusterPlugin            `json:"plugins,omitempty"`
}

type ImageCatalogRef struct {
	APIGroup string `json:"apiGroup"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Major    int    `json:"major"`
}

type InheritedMetadata struct {
	Labels map[string]string `json:"labels"`
}

type VolumeSpec struct {
	Size         string `json:"size"`
	StorageClass string `json:"storageClass,omitempty"`
}

type Resources struct {
	Requests map[string]string `json:"requests"`
	Limits   map[string]string `json:"limits"`
}

type ClusterAffinity struct {
	EnablePodAntiAffinity bool   `json:"enablePodAntiAffinity"`
	PodAntiAffinityType   string `json:"podAntiAffinityType"`
	TopologyKey           string `json:"topologyKey"`
}

type TopologySpreadConstraint struct {
	MaxSkew           int           `json:"maxSkew"`
	TopologyKey       string        `json:"topologyKey"`
	WhenUnsatisfiable string        `json:"whenUnsatisfiable"`
	LabelSelector     LabelSelector `json:"labelSelector"`
}

type LabelSelector struct {
	MatchLabels map[string]string `json:"matchLabels"`
}

type PostgresConfig struct {
	Parameters             map[string]string  `json:"parameters,omitempty"`
	PgHBA                  []string           `json:"pg_hba,omitempty"`
	SharedPreloadLibraries []string           `json:"shared_preload_libraries,omitempty"`
	Synchronous            *Synchronous       `json:"synchronous,omitempty"`
	Extensions             []ClusterExtension `json:"extensions,omitempty"`
}

// ClusterExtension is an extension mounted from an image (CNPG image volume
// extensions, PostgreSQL 18+).
type ClusterExtension struct {
	Name                 string         `json:"name"`
	Image                ExtensionImage `json:"image"`
	ExtensionControlPath []string       `json:"extension_control_path,omitempty"`
	DynamicLibraryPath   []string       `json:"dynamic_library_path,omitempty"`
	LDLibraryPath        []string       `json:"ld_library_path,omitempty"`
}

type ExtensionImage struct {
	Reference  string `json:"reference"`
	PullPolicy string `json:"pullPolicy,omitempty"`
}

type Synchronous struct {
	Method         string `json:"method"`
	Number         int    `json:"number"`
	DataDurability string `json:"dataDurability"`
}

type Bootstrap struct {
	InitDB   *InitDB   `json:"initdb,omitempty"`
	Recovery *Recovery `json:"recovery,omitempty"`
}

type InitDB struct {
	Database      string `json:"database"`
	Owner         string `json:"owner"`
	Encoding      string `json:"encoding"`
	LocaleCollate string `json:"localeCollate"`
	LocaleCType   string `json:"localeCType"`
}

type Recovery struct {
	Source         string          `json:"source"`
	Database       string          `json:"database,omitempty"`
	Owner          string          `json:"owner,omitempty"`
	RecoveryTarget *RecoveryTarget `json:"recoveryTarget,omitempty"`
}

type RecoveryTarget struct {
	TargetTime string `json:"targetTime"`
}

type ReplicaTopology struct {
	Self           string `json:"self"`
	Primary        string `json:"primary"`
	Source         string `json:"source"`
	PromotionToken string `json:"promotionToken,omitempty"`
}

type ExternalCluster struct {
	Name   string       `json:"name"`
	Plugin PluginConfig `json:"plugin"`
}

type PluginConfig struct {
	Name       string            `json:"name"`
	Parameters map[string]string `json:"parameters"`
}

type ClusterPlugin struct {
	Name          string            `json:"name"`
	IsWALArchiver bool              `json:"isWALArchiver"`
	Parameters    map[string]string `json:"parameters"`
}

type Managed struct {
	Roles    []ManagedRole    `json:"roles,omitempty"`
	Services *ManagedServices `json:"services,omitempty"`
}

type ManagedRole struct {
	Name            string   `json:"name"`
	Ensure          string   `json:"ensure"`
	Login           bool     `json:"login"`
	CreateDB        bool     `json:"createdb"`
	ConnectionLimit int      `json:"connectionLimit"`
	InRoles         []string `json:"inRoles,omitempty"`
	PasswordSecret  *Ref     `json:"passwordSecret,omitempty"`
}

type ManagedServices struct {
	Additional []ManagedService `json:"additional"`
}

type ManagedService struct {
	SelectorType    string          `json:"selectorType"`
	ServiceTemplate ServiceTemplate `json:"serviceTemplate"`
}

type ServiceTemplate struct {
	Metadata struct {
		Name        string            `json:"name"`
		Annotations map[string]string `json:"annotations,omitempty"`
	} `json:"metadata"`
	Spec struct {
		Type                     string   `json:"type"`
		LoadBalancerSourceRanges []string `json:"loadBalancerSourceRanges,omitempty"`
	} `json:"spec"`
}

type ClusterMonitoring struct {
	CustomQueriesConfigMap []KeyRef `json:"customQueriesConfigMap"`
}

// --- barmancloud.cnpg.io/v1 ObjectStore, postgresql.cnpg.io/v1 ScheduledBackup

type ObjectStore struct {
	APIVersion string          `json:"apiVersion"`
	Kind       string          `json:"kind"`
	Metadata   Meta            `json:"metadata"`
	Spec       ObjectStoreSpec `json:"spec"`
}

type ObjectStoreSpec struct {
	// Unset on a restore source: nothing is ever pruned through it.
	RetentionPolicy string            `json:"retentionPolicy,omitempty"`
	Configuration   BarmanObjectStore `json:"configuration"`
}

type BarmanObjectStore struct {
	DestinationPath string      `json:"destinationPath"`
	EndpointURL     string      `json:"endpointURL,omitempty"`
	EndpointCA      *KeyRef     `json:"endpointCA,omitempty"`
	S3Credentials   S3Keys      `json:"s3Credentials"`
	WAL             *WALBackup  `json:"wal,omitempty"`
	Data            *DataBackup `json:"data,omitempty"`
}

type S3Keys struct {
	AccessKeyID     KeyRef  `json:"accessKeyId"`
	SecretAccessKey KeyRef  `json:"secretAccessKey"`
	Region          *KeyRef `json:"region,omitempty"`
}

type WALBackup struct {
	Compression string `json:"compression"`
	MaxParallel int    `json:"maxParallel"`
}

type DataBackup struct {
	Compression string `json:"compression"`
	Jobs        int    `json:"jobs"`
}

type ScheduledBackup struct {
	APIVersion string              `json:"apiVersion"`
	Kind       string              `json:"kind"`
	Metadata   Meta                `json:"metadata"`
	Spec       ScheduledBackupSpec `json:"spec"`
}

type ScheduledBackupSpec struct {
	Schedule             string `json:"schedule"`
	Immediate            bool   `json:"immediate"`
	BackupOwnerReference string `json:"backupOwnerReference"`
	Method               string `json:"method"`
	PluginConfiguration  Ref    `json:"pluginConfiguration"`
	Cluster              Ref    `json:"cluster"`
}

// --- postgresql.cnpg.io/v1 Database, Pooler

type DatabaseObject struct {
	APIVersion string       `json:"apiVersion"`
	Kind       string       `json:"kind"`
	Metadata   Meta         `json:"metadata"`
	Spec       DatabaseSpec `json:"spec"`
}

type DatabaseSpec struct {
	Cluster               Ref                 `json:"cluster"`
	Name                  string              `json:"name"`
	Owner                 string              `json:"owner"`
	Ensure                string              `json:"ensure"`
	DatabaseReclaimPolicy string              `json:"databaseReclaimPolicy"`
	Extensions            []DatabaseExtension `json:"extensions,omitempty"`
}

type DatabaseExtension struct {
	Name   string `json:"name"`
	Ensure string `json:"ensure"`
}

type PoolerObject struct {
	APIVersion string     `json:"apiVersion"`
	Kind       string     `json:"kind"`
	Metadata   Meta       `json:"metadata"`
	Spec       PoolerSpec `json:"spec"`
}

type PoolerSpec struct {
	Cluster   Ref       `json:"cluster"`
	Instances int       `json:"instances"`
	Type      string    `json:"type"`
	PgBouncer PgBouncer `json:"pgbouncer"`
	Template  struct {
		Metadata struct {
			Labels map[string]string `json:"labels"`
		} `json:"metadata"`
		Spec struct {
			// Required by the Pooler schema, even when empty.
			Containers []any `json:"containers"`
			Affinity   struct {
				PodAntiAffinity struct {
					Preferred []WeightedPodAffinityTerm `json:"preferredDuringSchedulingIgnoredDuringExecution"`
				} `json:"podAntiAffinity"`
			} `json:"affinity"`
		} `json:"spec"`
	} `json:"template"`
}

type PgBouncer struct {
	PoolMode   string            `json:"poolMode"`
	Parameters map[string]string `json:"parameters"`
}

type WeightedPodAffinityTerm struct {
	Weight          int `json:"weight"`
	PodAffinityTerm struct {
		TopologyKey   string        `json:"topologyKey"`
		LabelSelector LabelSelector `json:"labelSelector"`
	} `json:"podAffinityTerm"`
}

// --- monitoring.coreos.com/v1 PodMonitor, PrometheusRule; v1 ConfigMap, Secret

type PodMonitor struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   Meta   `json:"metadata"`
	Spec       struct {
		Selector            LabelSelector `json:"selector"`
		PodMetricsEndpoints []struct {
			Port string `json:"port"`
		} `json:"podMetricsEndpoints"`
	} `json:"spec"`
}

type PrometheusRule struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   Meta   `json:"metadata"`
	Spec       struct {
		Groups []RuleGroup `json:"groups"`
	} `json:"spec"`
}

type RuleGroup struct {
	Name  string `json:"name"`
	Rules []any  `json:"rules"`
}

type ConfigMap struct {
	APIVersion string            `json:"apiVersion"`
	Kind       string            `json:"kind"`
	Metadata   Meta              `json:"metadata"`
	Data       map[string]string `json:"data"`
}

// Secret is a copy of a Secret on the control plane: its data and type are
// patched in by the Object's references, never written here.
type Secret struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   Meta   `json:"metadata"`
}

// --- kubernetes.m.crossplane.io/v1alpha1 Object (provider-kubernetes)

type KubernetesObject struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   Meta   `json:"metadata"`
	Spec       struct {
		ProviderConfigRef struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		} `json:"providerConfigRef"`
		// Status changes (CNPG's Cluster.status) show up without waiting
		// for the poll interval; needs the provider's --enable-watches.
		Watch       bool        `json:"watch"`
		References  []Reference `json:"references,omitempty"`
		ForProvider struct {
			Manifest Object `json:"manifest"`
		} `json:"forProvider"`
	} `json:"spec"`
}

type Reference struct {
	PatchesFrom struct {
		APIVersion string `json:"apiVersion"`
		Kind       string `json:"kind"`
		Name       string `json:"name"`
		Namespace  string `json:"namespace"`
		FieldPath  string `json:"fieldPath"`
	} `json:"patchesFrom"`
}

// --- grafana.integreatly.org/v1beta1 GrafanaDashboard

type GrafanaDashboard struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   Meta   `json:"metadata"`
	Spec       struct {
		InstanceSelector          LabelSelector `json:"instanceSelector"`
		AllowCrossNamespaceImport bool          `json:"allowCrossNamespaceImport"`
		Folder                    string        `json:"folder"`
		// Unique per cluster (the upstream JSON hardcodes "cloudnative-pg",
		// which made every cluster's dashboard collide in one Grafana).
		UID          string `json:"uid"`
		ResyncPeriod string `json:"resyncPeriod"`
		Datasources  []struct {
			InputName      string `json:"inputName"`
			DatasourceName string `json:"datasourceName"`
		} `json:"datasources"`
		JSON string `json:"json"`
	} `json:"spec"`
}
