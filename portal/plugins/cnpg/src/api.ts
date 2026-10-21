import {
  createApiRef,
  DiscoveryApi,
  FetchApi,
} from '@backstage/frontend-plugin-api';
import { ResponseError } from '@backstage/errors';
import type {
  AuditLog,
  BucketDetails,
  BucketList,
  CacheConnection,
  ClusterConnection,
  ClusterExtension,
  ClusterSize,
  LocationHealth,
  LocationSpec,
  LocationSummary,
  PodLogs,
  PostgresCluster,
  PostgresClusterDetails,
  PostgresClusterSummary,
  Project,
  PromotionRequest,
  ProjectSummary,
  ValkeyCache,
  ValkeyCacheDetails,
  ValkeyCacheSummary,
  VolumeList,
  VolumeSummary,
} from '@internal/backstage-plugin-cnpg-common';

export interface CnpgPortalConfig {
  grafanaUrl?: string;
  defaultNamespace?: string;
  storageClasses: string[];
}

export interface CreateClusterRequest {
  name: string;
  namespace: string;
  owner?: string;
  spec: Record<string, unknown>;
  /** Validate against the XRD (server-side dry run) without creating anything. */
  dryRun?: boolean;
}

/** A new cluster in a project, restored from a backup folder. */
export interface RestoreRequest {
  /** Name of the new cluster. */
  name: string;
  /** A cluster's current backup folder, or a folder in the project's inventory (also of deleted clusters). */
  from: { cluster: string } | { serverName: string };
  /** RFC 3339; leave out for the latest state. */
  targetTime?: string;
  storageSize?: string;
  dryRun?: boolean;
}

export interface CreateProjectRequest {
  /** Also the namespace name. */
  name: string;
  owner?: string;
  description?: string;
  /** Further Project spec (access, quota, observability). */
  spec?: Record<string, unknown>;
  /** Validate against the XRD (server-side dry run) without creating anything. */
  dryRun?: boolean;
}

export interface PodLogsRequest {
  pod: string;
  /** Location the pod runs in (default: local). */
  location?: string;
  tailLines?: number;
  /** The last terminated container instead of the running one. */
  previous?: boolean;
}

export interface LocationRequest {
  name: string;
  /** kubeconfig file contents; validated and cut down to one context by the backend. */
  kubeconfig: string;
  context?: string;
  spec: LocationSpec;
}

export interface LocationUpdate {
  /** Replaces all settings. */
  spec: LocationSpec;
  /** A new kubeconfig; leave out to keep the stored one. */
  kubeconfig?: string;
  context?: string;
}

/** A change to an existing cluster or project. */
export interface PatchRequest {
  /** JSON merge patch of the spec: only these fields change, null removes one. */
  spec: Record<string, unknown>;
  /** Validate the change (server-side dry run) without applying it. */
  dryRun?: boolean;
}

/** Client for the cnpg backend plugin (/api/cnpg). */
export interface CnpgApi {
  getConfig(): Promise<CnpgPortalConfig>;
  /** The sizes (SKUs) spec.size can name, in catalog order; empty without a catalog. */
  listSizes(): Promise<ClusterSize[]>;
  /** The extensions a cluster may add to its databases, in catalog order; empty without a catalog. */
  listExtensions(): Promise<ClusterExtension[]>;
  listClusters(namespace?: string): Promise<PostgresClusterSummary[]>;
  getCluster(namespace: string, name: string): Promise<PostgresClusterDetails>;
  createCluster(request: CreateClusterRequest): Promise<PostgresCluster>;
  updateCluster(namespace: string, name: string, spec: Record<string, unknown>): Promise<PostgresCluster>;
  patchCluster(
    namespace: string,
    name: string,
    request: PatchRequest & { owner?: string | null },
  ): Promise<PostgresCluster>;
  deleteCluster(namespace: string, name: string): Promise<void>;
  /** Moves the primary to the other site; 409 when that can't happen now. */
  promoteCluster(
    namespace: string,
    name: string,
    request: PromotionRequest & { dryRun?: boolean },
  ): Promise<PostgresCluster>;
  getPodLogs(namespace: string, name: string, request: PodLogsRequest): Promise<PodLogs>;
  /** The app connection URI (password included) via the external load balancer. */
  getConnection(namespace: string, name: string): Promise<ClusterConnection>;
  /** Creates a new cluster in `project` from a backup folder; the source is only read. */
  restoreCluster(project: string, request: RestoreRequest): Promise<PostgresCluster>;
  listProjects(): Promise<ProjectSummary[]>;
  getProject(name: string): Promise<{ summary: ProjectSummary; resource: Project }>;
  createProject(request: CreateProjectRequest): Promise<Project>;
  patchProject(name: string, request: PatchRequest): Promise<Project>;
  /** Refused (409) while the project still has PostgreSQL clusters. */
  deleteProject(name: string): Promise<void>;
  /** Kubernetes events of the project's namespace and pgaudit records of its clusters, newest first. */
  getAuditLog(project: string, options?: { tailLines?: number }): Promise<AuditLog>;
  listLocations(): Promise<LocationSummary[]>;
  getLocation(name: string): Promise<LocationSummary>;
  /** Probes the location again instead of returning the cached health. */
  checkLocation(name: string): Promise<LocationSummary>;
  /** Validates a kubeconfig and probes its cluster without storing anything. */
  testLocation(request: LocationRequest): Promise<LocationHealth>;
  createLocation(request: LocationRequest): Promise<LocationSummary>;
  /** Probes a replacement kubeconfig (or the stored one) without saving. */
  testLocationUpdate(name: string, request: LocationUpdate): Promise<LocationHealth>;
  updateLocation(name: string, request: LocationUpdate): Promise<LocationSummary>;
  deleteLocation(name: string): Promise<void>;
  /** Every bucket on the COSI account; only those the cluster knows when the store can't be read. */
  listBuckets(): Promise<BucketList>;
  getBucket(name: string): Promise<BucketDetails>;
  /** Deletes an orphaned bucket and everything in it; 409 for one in use. */
  deleteBucket(name: string): Promise<void>;
  /** The disks of PostgreSQL instances in every project's locations (or one project's). */
  listVolumes(project?: string): Promise<VolumeList>;
  /** Deletes an orphaned claim or released volume with its storage; 409 for one in use. */
  deleteVolume(volume: VolumeSummary): Promise<void>;
  listCaches(namespace?: string): Promise<ValkeyCacheSummary[]>;
  getCache(namespace: string, name: string): Promise<ValkeyCacheDetails>;
  createCache(request: CreateClusterRequest): Promise<ValkeyCache>;
  patchCache(namespace: string, name: string, request: PatchRequest & { owner?: string | null }): Promise<ValkeyCache>;
  /** Deletes the cache and every key in it. */
  deleteCache(namespace: string, name: string): Promise<void>;
  /** valkey://default:<password>@host:6379 from the Secret in the cache's location. */
  getCacheConnection(namespace: string, name: string): Promise<CacheConnection>;
}

export const cnpgApiRef = createApiRef<CnpgApi>().with({
  id: 'plugin.cnpg.client',
  pluginId: 'cnpg',
});

const enc = encodeURIComponent;

export class CnpgClient implements CnpgApi {
  constructor(
    private readonly options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi },
  ) {}

  getConfig() {
    return this.#request<CnpgPortalConfig>('/config');
  }

  async listSizes() {
    return (await this.#request<{ items: ClusterSize[] }>('/sizes')).items;
  }

  async listExtensions() {
    return (await this.#request<{ items: ClusterExtension[] }>('/extensions')).items;
  }

  async listClusters(namespace?: string) {
    const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return (await this.#request<{ items: PostgresClusterSummary[] }>(`/clusters${query}`)).items;
  }

  getCluster(namespace: string, name: string) {
    return this.#request<PostgresClusterDetails>(`/clusters/${enc(namespace)}/${enc(name)}`);
  }

  createCluster(request: CreateClusterRequest) {
    return this.#request<PostgresCluster>('/clusters', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  updateCluster(namespace: string, name: string, spec: Record<string, unknown>) {
    return this.#request<PostgresCluster>(`/clusters/${enc(namespace)}/${enc(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ spec }),
    });
  }

  patchCluster(namespace: string, name: string, request: PatchRequest & { owner?: string | null }) {
    return this.#request<PostgresCluster>(`/clusters/${enc(namespace)}/${enc(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(request),
    });
  }

  async deleteCluster(namespace: string, name: string) {
    await this.#request(`/clusters/${enc(namespace)}/${enc(name)}`, { method: 'DELETE' });
  }

  promoteCluster(namespace: string, name: string, request: PromotionRequest & { dryRun?: boolean }) {
    return this.#request<PostgresCluster>(`/clusters/${enc(namespace)}/${enc(name)}/promote`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  getPodLogs(namespace: string, name: string, request: PodLogsRequest) {
    const query = new URLSearchParams({ pod: request.pod });
    if (request.location) query.set('location', request.location);
    if (request.tailLines) query.set('tailLines', String(request.tailLines));
    if (request.previous) query.set('previous', 'true');
    return this.#request<PodLogs>(`/clusters/${enc(namespace)}/${enc(name)}/logs?${query}`);
  }

  getConnection(namespace: string, name: string) {
    return this.#request<ClusterConnection>(`/clusters/${enc(namespace)}/${enc(name)}/connection`);
  }

  restoreCluster(project: string, request: RestoreRequest) {
    return this.#request<PostgresCluster>(`/projects/${enc(project)}/restore`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async listProjects() {
    return (await this.#request<{ items: ProjectSummary[] }>('/projects')).items;
  }

  getProject(name: string) {
    return this.#request<{ summary: ProjectSummary; resource: Project }>(`/projects/${enc(name)}`);
  }

  createProject(request: CreateProjectRequest) {
    return this.#request<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  patchProject(name: string, request: PatchRequest) {
    return this.#request<Project>(`/projects/${enc(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(request),
    });
  }

  async deleteProject(name: string) {
    await this.#request(`/projects/${enc(name)}`, { method: 'DELETE' });
  }

  getAuditLog(project: string, options?: { tailLines?: number }) {
    const query = options?.tailLines ? `?tailLines=${options.tailLines}` : '';
    return this.#request<AuditLog>(`/projects/${enc(project)}/audit${query}`);
  }

  async listLocations() {
    return (await this.#request<{ items: LocationSummary[] }>('/locations')).items;
  }

  getLocation(name: string) {
    return this.#request<LocationSummary>(`/locations/${enc(name)}`);
  }

  checkLocation(name: string) {
    return this.#request<LocationSummary>(`/locations/${enc(name)}/check`, { method: 'POST' });
  }

  async testLocation(request: LocationRequest) {
    const { health } = await this.#request<{ health: LocationHealth }>('/locations', {
      method: 'POST',
      body: JSON.stringify({ ...request, dryRun: true }),
    });
    return health;
  }

  createLocation(request: LocationRequest) {
    return this.#request<LocationSummary>('/locations', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async testLocationUpdate(name: string, request: LocationUpdate) {
    const { health } = await this.#request<{ health: LocationHealth }>(
      `/locations/${enc(name)}`,
      { method: 'PUT', body: JSON.stringify({ ...request, dryRun: true }) },
    );
    return health;
  }

  updateLocation(name: string, request: LocationUpdate) {
    return this.#request<LocationSummary>(`/locations/${enc(name)}`, {
      method: 'PUT',
      body: JSON.stringify(request),
    });
  }

  async deleteLocation(name: string) {
    await this.#request(`/locations/${enc(name)}`, { method: 'DELETE' });
  }

  listBuckets() {
    return this.#request<BucketList>('/buckets');
  }

  getBucket(name: string) {
    return this.#request<BucketDetails>(`/buckets/${enc(name)}`);
  }

  async deleteBucket(name: string) {
    await this.#request(`/buckets/${enc(name)}`, { method: 'DELETE' });
  }

  listVolumes(project?: string) {
    return this.#request<VolumeList>(`/volumes${project ? `?project=${enc(project)}` : ''}`);
  }

  async deleteVolume(volume: VolumeSummary) {
    const path =
      volume.state === 'released'
        ? `/volumes/${enc(volume.location)}/persistentvolumes/${enc(volume.volume ?? '')}`
        : `/volumes/${enc(volume.location)}/claims/${enc(volume.project)}/${enc(volume.claim)}`;
    await this.#request(path, { method: 'DELETE' });
  }

  async listCaches(namespace?: string) {
    const query = namespace ? `?namespace=${enc(namespace)}` : '';
    return (await this.#request<{ items: ValkeyCacheSummary[] }>(`/caches${query}`)).items;
  }

  getCache(namespace: string, name: string) {
    return this.#request<ValkeyCacheDetails>(`/caches/${enc(namespace)}/${enc(name)}`);
  }

  createCache(request: CreateClusterRequest) {
    return this.#request<ValkeyCache>('/caches', { method: 'POST', body: JSON.stringify(request) });
  }

  patchCache(namespace: string, name: string, request: PatchRequest & { owner?: string | null }) {
    return this.#request<ValkeyCache>(`/caches/${enc(namespace)}/${enc(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(request),
    });
  }

  async deleteCache(namespace: string, name: string) {
    await this.#request(`/caches/${enc(namespace)}/${enc(name)}`, { method: 'DELETE' });
  }

  getCacheConnection(namespace: string, name: string) {
    return this.#request<CacheConnection>(`/caches/${enc(namespace)}/${enc(name)}/connection`);
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('cnpg');
    const response = await this.options.fetchApi.fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }
    return (await response.json()) as T;
  }
}

