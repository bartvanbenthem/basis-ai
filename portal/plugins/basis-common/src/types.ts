/**
 * Shapes of the postgres.cndev.nl/v1alpha1 PostgresCluster API served by
 * api/. The XRD is the source of truth (and the API server
 * validates every write against it); these types only cover what the portal
 * reads or sends.
 */

import { specExtensions } from './extensions';
import type { Classification, Environment, ProjectGovernanceStatus } from './governance';
import { ClusterProfile, clusterProfile } from './profiles';
import type { ClusterResources } from './sizes';

export const XR_GROUP = 'postgres.cndev.nl';
export const XR_VERSION = 'v1alpha1';
export const XR_PLURAL = 'postgresclusters';
export const XR_KIND = 'PostgresCluster';

/** Annotation on catalog Resource entities: "<namespace>/<name>" of their PostgresCluster. */
export const CLUSTER_ANNOTATION = 'postgres.cndev.nl/postgrescluster';

/** platform.cndev.nl/v1alpha1 Project (cluster-scoped): one namespace with its own Prometheus + Grafana. */
export const PROJECT_GROUP = 'platform.cndev.nl';
export const PROJECT_VERSION = 'v1alpha1';
export const PROJECT_PLURAL = 'projects';
export const PROJECT_KIND = 'Project';

/** Annotation on catalog project entities: the Project (= namespace) name. */
export const PROJECT_ANNOTATION = 'platform.cndev.nl/project';

/**
 * Reserved location name. It used to stand for the platform cluster itself;
 * the control plane now runs no databases, so no Location may take it.
 */
export const LOCAL_LOCATION = 'local';

/** The two roles a location plays in a Project. */
export type Site = 'protected' | 'recovery';

export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** One location a PostgresCluster runs in (status.locations[]). */
export interface ClusterLocationStatus {
  location: string;
  site?: Site;
  /** primary, replica, or promoting (waiting for the old primary's demotion token). */
  role: 'primary' | 'replica' | 'promoting' | string;
  ready?: boolean;
  phase?: string;
  instances?: number;
  readyInstances?: number;
  currentPrimary?: string;
}

export interface PostgresClusterStatus {
  ready?: boolean;
  phase?: string;
  instances?: number;
  readyInstances?: number;
  currentPrimary?: string;
  image?: string;
  message?: string;
  endpoints?: Record<string, string>;
  secrets?: { app?: string; superuser?: string };
  /** serverName: the folder the primary archives to, what restore.source.serverName names. */
  backup?: { serverName?: string; lastSuccessfulBackup?: string; firstRecoverabilityPoint?: string };
  monitoring?: { dashboardUid?: string };
  /** The Project's backup bucket the cluster archives to (no destinationPath of its own), pinned on first use. */
  backupStore?: { destinationPath?: string; endpointURL?: string; namespace?: string; region?: boolean };
  /** The Project's locations the cluster was placed in, pinned on first use. */
  sites?: { protected?: string; recovery?: string };
  /** What the instances run with: spec.size resolved from the catalog, or spec.resources. */
  sizing?: { size?: string; resources?: ClusterResources; parameters?: Record<string, string> };
  primaryLocation?: string;
  primarySite?: Site;
  locations?: ClusterLocationStatus[];
  conditions?: Condition[];
}

export interface PostgresCluster {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: Record<string, any>;
  status?: PostgresClusterStatus;
}

/** One row in the portal's cluster list. */
export interface PostgresClusterSummary {
  name: string;
  namespace: string;
  postgresVersion?: number;
  /** spec.size; unset for a cluster with resources of its own. */
  size?: string;
  /** spec.profile. */
  profile: ClusterProfile;
  instances: number;
  readyInstances: number;
  phase: string;
  currentPrimary?: string;
  /** Crossplane's Ready condition: every composed object exists and the Cluster is healthy. */
  ready: boolean;
  synced: boolean;
  deleting: boolean;
  message?: string;
  owner?: string;
  pooler: boolean;
  backup: boolean;
  /** Every extension its databases list (spec.database.extensions, spec.databases[].extensions). */
  extensions: string[];
  /** uid of the composed GrafanaDashboard; unset when the dashboard is disabled. */
  dashboardUid?: string;
  /** The protected location, where the cluster was created; empty until known. */
  location: string;
  /** Whether a replica cluster runs in the recovery location (spec.geoReplication.enabled). */
  geoReplication: boolean;
  /** The recovery location, when the cluster has (or still has) a replica cluster there. */
  recoveryLocation?: string;
  /** Where the primary runs now. */
  primaryLocation: string;
  primarySite: Site;
  createdAt?: string;
  /** The Project whose namespace the cluster lives in, if any (filled in by the backend). */
  project?: string;
  /** That project's Grafana (status.grafana.url); takes precedence over basis.grafanaUrl. */
  grafanaUrl?: string;
  /** The GenAIStack that composes this cluster, if any: it's changed through the stack. */
  stack?: string;
}

export interface InstancePod {
  name: string;
  /** Location (Kubernetes cluster) the pod runs in. */
  location: string;
  role: string;
  phase: string;
  ready: boolean;
  node?: string;
  restarts: number;
  createdAt?: string;
}

export interface ClusterEvent {
  location: string;
  type: string;
  reason: string;
  message: string;
  object: string;
  count: number;
  lastSeen?: string;
}

/** The tail of one cluster pod's stdout, as the Logs tab shows it. */
export interface PodLogs {
  pod: string;
  location: string;
  container: string;
  /** Raw log text; CNPG writes one JSON object per line. */
  text: string;
}

/** The app user's connection URI, pointed at the external load balancer when it has an address. */
export interface ClusterConnection {
  /** postgresql://user:password@host:5432/db */
  uri: string;
  /** Location whose Secret and load balancer were read (the primary's). */
  location: string;
  /** False while the LB has no address yet: the URI still has the in-cluster host. */
  external: boolean;
}

/** Everything the detail page shows, gathered in one round-trip. */
export interface PostgresClusterDetails {
  summary: PostgresClusterSummary;
  resource: PostgresCluster;
  pods: InstancePod[];
  events: ClusterEvent[];
  /** Live CNPG Cluster status of the primary's location (instance roles, timeline...). */
  cnpgStatus?: Record<string, any>;
  /**
   * Load balancer IP (or hostname) of the "<name>-external" read-write
   * service in the primary's location; unset until the LB has one.
   */
  externalHost?: string;
  /** Locations whose pods/events couldn't be read, with the reason. */
  unreachable?: Array<{ location: string; message: string }>;
}

export function conditionStatus(
  cluster: PostgresCluster,
  type: string,
): Condition | undefined {
  return cluster.status?.conditions?.find(c => c.type === type);
}

/** `project` (the cluster's, if known) fills in its sites until the composition reports them. */
export function summarize(cluster: PostgresCluster, project?: Project): PostgresClusterSummary {
  const { metadata, spec, status } = cluster;
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    postgresVersion: spec.postgresVersion,
    size: spec.size || undefined,
    profile: clusterProfile(spec),
    instances: spec.instances ?? 0,
    readyInstances: status?.readyInstances ?? 0,
    phase: status?.phase ?? 'Pending',
    currentPrimary: status?.currentPrimary || undefined,
    ready: conditionStatus(cluster, 'Ready')?.status === 'True',
    synced: conditionStatus(cluster, 'Synced')?.status === 'True',
    deleting: Boolean(metadata.deletionTimestamp),
    message: status?.message,
    owner: metadata.labels?.['backstage.io/owner'],
    pooler: Boolean(spec.pooler?.enabled),
    backup: Boolean(spec.backup?.enabled),
    extensions: specExtensions(spec),
    dashboardUid: status?.monitoring?.dashboardUid || undefined,
    ...clusterSites(cluster, project),
    createdAt: metadata.creationTimestamp,
    stack: metadata.labels?.['ai.cndev.nl/genaistack'] || undefined,
  };
}

/**
 * Where a cluster runs, from its status (the composition pins its sites
 * there); `project`'s locations stand in until the first reconcile.
 */
export function clusterSites(
  cluster: PostgresCluster,
  project?: Project,
): Pick<PostgresClusterSummary, 'location' | 'geoReplication' | 'recoveryLocation' | 'primaryLocation' | 'primarySite'> {
  const { spec, status } = cluster;
  const location = status?.sites?.protected || project?.spec.locations?.protected || '';
  const geoReplication = Boolean(spec.geoReplication?.enabled);
  const recovery = status?.sites?.recovery || project?.spec.locations?.recovery;
  const inRecovery = (status?.locations ?? []).some(l => l.site === 'recovery');
  const primarySite: Site = status?.primarySite ?? 'protected';
  return {
    location,
    geoReplication,
    recoveryLocation: recovery && (geoReplication || inRecovery) ? recovery : undefined,
    primaryLocation:
      status?.primaryLocation || (primarySite === 'recovery' && recovery ? recovery : location),
    primarySite,
  };
}

/** Every location a cluster runs in: the protected site first, then the recovery site. */
export function clusterLocations(cluster: PostgresCluster): string[] {
  const reported = (cluster.status?.locations ?? []).map(l => l.location).filter(Boolean);
  if (reported.length) return reported;
  const { location, recoveryLocation } = clusterSites(cluster);
  return [location, recoveryLocation].filter((l): l is string => Boolean(l));
}

/**
 * A backup folder (Barman server name) in a project's bucket, from the
 * Project's inventory (status.backup.servers). It stays listed, inactive,
 * after its cluster is deleted: the bucket keeps the backups.
 */
export interface BackupServer {
  serverName: string;
  /** The PostgresCluster that archives (or archived) to it. */
  cluster?: string;
  location?: string;
  /** Whether that cluster still archives to it. */
  active?: boolean;
  postgresVersion?: number;
  database?: string;
  owner?: string;
  firstRecoverabilityPoint?: string;
  lastSuccessfulBackup?: string;
}

/**
 * Whether a location reaches the project's backup bucket: a CronJob there
 * (backup-check in the project namespace) writes, reads back and deletes a
 * test object with that location's keys every few minutes.
 */
export interface BackupReachability {
  location: string;
  /** Pending: no check yet. Checking: one runs after a failure. */
  state: 'Pending' | 'Reachable' | 'Unreachable' | 'Checking';
  lastCheckTime?: string;
  lastSuccessTime?: string;
  /** Why the last check failed, from the job in that location (filled in by the backend). */
  detail?: string;
}

export interface ProjectStatus {
  ready?: boolean;
  message?: string;
  namespace?: string;
  locations?: Array<{ location: string; site?: Site; ready?: boolean; message?: string }>;
  prometheus?: { url?: string; remoteWriteUrl?: string };
  /** The COSI backup bucket (Project spec.backup); unset without one. */
  backup?: {
    ready?: boolean;
    bucket?: string;
    endpoint?: string;
    region?: string;
    destinationPath?: string;
    /** Control-plane namespace with the COSI objects and credentials (the project's). */
    namespace?: string;
    /** Per location, the Secret with its S3 keys. */
    credentials?: Record<string, string>;
    reachability?: BackupReachability[];
    /** The backup folders in the bucket, including those of deleted clusters. */
    servers?: BackupServer[];
  };
  grafana?: {
    url?: string;
    internalUrl?: string;
    adminSecret?: string;
    instanceSelector?: Record<string, string>;
  };
  governance?: ProjectGovernanceStatus;
  conditions?: Condition[];
}

export interface Project {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    owner?: string;
    description?: string;
    deletionProtection?: boolean;
    /**
     * Where its databases run (protected) and where PostgresClusters with
     * geoReplication keep a replica cluster (recovery). Neither can change
     * once set; recovery can be added later.
     */
    locations?: { protected?: string; recovery?: string };
    access?: Array<{ group: string; role: 'admin' | 'edit' | 'view' }>;
    quota?: { cpu?: string; memory?: string; storage?: string };
    observability?: {
      prometheus?: { enabled?: boolean; retention?: string; storage?: { size?: string } };
      grafana?: { enabled?: boolean; ingress?: boolean };
    };
    backup?: { bucket?: boolean; bucketClassName?: string; bucketAccessClassName?: string };
    classification?: Classification;
    environment?: Environment;
    costCenter?: string;
    budget?: { monthly?: number; monthlyTokens?: number };
    /** YYYY-MM-DD: after it nothing new can be created in the project. */
    expiresAt?: string;
    [key: string]: unknown;
  };
  status?: ProjectStatus;
}

/** One row in the portal's project list / project picker. */
export interface ProjectSummary {
  /** Also the namespace name. */
  name: string;
  owner?: string;
  description?: string;
  /** Crossplane's Ready condition: namespace, Prometheus and Grafana are up. */
  ready: boolean;
  synced: boolean;
  deleting: boolean;
  deletionProtection: boolean;
  message?: string;
  prometheus: boolean;
  grafana: boolean;
  grafanaUrl?: string;
  /** Where its databases run. */
  protectedLocation?: string;
  /** Where replica clusters run, if the project has a recovery site. */
  recoveryLocation?: string;
  /** Both, protected first. */
  locations: string[];
  /** Its COSI backup bucket, which PostgresClusters without a backup destination of their own use. */
  backupBucket?: { ready: boolean; bucket?: string; reachability: BackupReachability[] };
  classification?: Classification;
  environment?: Environment;
  costCenter?: string;
  expiresAt?: string;
  expired?: boolean;
  budget?: { monthly?: number; monthlyTokens?: number };
  createdAt?: string;
}

export function summarizeProject(project: Project): ProjectSummary {
  const { metadata, spec, status } = project;
  const condition = (type: string) => status?.conditions?.find(c => c.type === type);
  return {
    name: metadata.name,
    owner: spec.owner || undefined,
    description: spec.description || undefined,
    ready: condition('Ready')?.status === 'True',
    synced: condition('Synced')?.status === 'True',
    deleting: Boolean(metadata.deletionTimestamp),
    deletionProtection: spec.deletionProtection !== false,
    message: status?.message,
    prometheus: spec.observability?.prometheus?.enabled !== false,
    grafana: spec.observability?.grafana?.enabled !== false,
    grafanaUrl: status?.grafana?.url || undefined,
    protectedLocation: spec.locations?.protected || undefined,
    recoveryLocation: spec.locations?.recovery || undefined,
    locations: projectLocations(project),
    backupBucket: status?.backup
      ? {
          ready: Boolean(status.backup.ready),
          bucket: status.backup.bucket || undefined,
          reachability: status.backup.reachability ?? [],
        }
      : undefined,
    classification: spec.classification ?? 'internal',
    environment: spec.environment ?? 'production',
    costCenter: spec.costCenter || undefined,
    expiresAt: spec.expiresAt || undefined,
    expired: Boolean(status?.governance?.expired),
    budget: spec.budget,
    createdAt: metadata.creationTimestamp,
  };
}

/** A project's locations: the protected one first, then the recovery one. */
export function projectLocations(project: Project): string[] {
  const { protected: protectedLocation, recovery } = project.spec.locations ?? {};
  return [protectedLocation, recovery].filter((l): l is string => Boolean(l));
}
