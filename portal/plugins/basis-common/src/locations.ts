/**
 * Locations: the Kubernetes clusters the platform runs data services in; the
 * control plane (where Crossplane and the portal run) runs none. Each one is
 * a Location (platform.cndev.nl/v1alpha1, cluster-scoped, see
 * api/apis/location) with the settings below, pointing at a
 * Secret on the control plane (namespace `basis.locations.namespace`) that
 * holds its kubeconfig under the `kubeconfig` key. The Location composition
 * creates the provider-kubernetes ClusterProviderConfig the Project and
 * PostgresCluster compositions place objects through. The kubeconfig never
 * leaves the backend. A Project uses one location as its protected site and
 * optionally another as its recovery site.
 */

/** Label on every location Secret. */
export const LOCATION_LABEL = 'platform.cndev.nl/location';

export const LOCATION_ENVIRONMENTS = ['production', 'acceptance', 'test', 'development'] as const;
export type LocationEnvironment = (typeof LOCATION_ENVIRONMENTS)[number];

export const LOCATION_PROVIDERS = [
  'on-premises',
  'aks',
  'eks',
  'gke',
  'ske',
  'openshift',
  'kind',
  'other',
] as const;
export type LocationProvider = (typeof LOCATION_PROVIDERS)[number];

/** What a platform admin says about a location: the Location's spec minus its credentials. */
export interface LocationSpec {
  displayName?: string;
  description?: string;
  environment?: LocationEnvironment;
  provider?: LocationProvider;
  /** Region or data center, e.g. "westeurope" or "dc-amsterdam-2". */
  region?: string;
  /** Team responsible for the cluster (catalog entity ref or group name). */
  owner?: string;
  /** Default StorageClass for databases placed here; empty means the cluster's default. */
  storageClass?: string;
  /** Whether new databases may be placed here. */
  schedulable?: boolean;
}

export type CheckStatus = 'ok' | 'warning' | 'error';

export interface LocationCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export type LocationHealthStatus = 'healthy' | 'degraded' | 'unreachable';

/** The result of probing a location's API server from the portal backend. */
export interface LocationHealth {
  status: LocationHealthStatus;
  checkedAt: string;
  /** Round trip of the /version call. */
  latencyMs?: number;
  kubernetesVersion?: string;
  nodes?: { ready: number; total: number };
  checks: LocationCheck[];
}

/** Safe-to-show facts about the stored kubeconfig. */
export interface LocationConnection {
  server: string;
  context: string;
  /** "token", "client certificate" or "basic". */
  auth: string;
  /** Default namespace of the context, if any. */
  namespace?: string;
  insecureSkipTlsVerify: boolean;
}

/** The Location's status, as its composition reports it. */
export interface LocationStatus {
  /** Connected and both operators installed. */
  ready?: boolean;
  message?: string;
  /** Crossplane reached the API server with the kubeconfig. */
  connected?: boolean;
  /** Operators found there; unset until connected. */
  /** valkey, agentRouter: optional, for ValkeyCaches and GenAIStacks' gateways. */
  operators?: { cloudnativepg?: boolean; prometheusOperator?: boolean; valkey?: boolean; agentRouter?: boolean };
}

export interface LocationSummary {
  name: string;
  spec: LocationSpec;
  connection: LocationConnection;
  /** Whether its ClusterProviderConfig exists, i.e. Crossplane can place objects there. */
  providerConfig: boolean;
  /** What Crossplane sees (the portal's own probe is in {@link health}). */
  status?: LocationStatus;
  /** Projects that list this location (filled in by the backend). */
  projects?: string[];
  owner?: string;
  createdAt?: string;
  updatedAt?: string;
  health?: LocationHealth;
}
