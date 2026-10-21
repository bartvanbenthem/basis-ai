/**
 * Shapes of the cache.cndev.nl/v1alpha1 ValkeyCache API served by api/
 * (apis/valkeycache). The XRD is the source of truth; these types only cover
 * what the portal reads or sends.
 */

import type { ClusterEvent, Condition, InstancePod, Project, Site } from './types';

export const CACHE_GROUP = 'cache.cndev.nl';
export const CACHE_VERSION = 'v1alpha1';
export const CACHE_PLURAL = 'valkeycaches';
export const CACHE_KIND = 'ValkeyCache';

/** Annotation on catalog Resource entities: "<namespace>/<name>" of their ValkeyCache. */
export const CACHE_ANNOTATION = 'cache.cndev.nl/valkeycache';

/** exact: key/value with TTLs. semantic: also vector search (valkey-search). */
export type CacheMode = 'exact' | 'semantic';

export const CACHE_MODES: Record<CacheMode, { displayName: string; description: string }> = {
  exact: {
    displayName: 'Exact',
    description:
      'Key/value with TTLs: a hash of the normalised prompt plus its context, tool, SQL and search results.',
  },
  semantic: {
    displayName: 'Semantic',
    description:
      'Also vector search (valkey-search: FT.CREATE / FT.SEARCH, HNSW/KNN) for embedding-based hits, e.g. LiteLLM\'s valkey-semantic cache.',
  },
};

/** maxmemory-policy values the XRD allows, cache-friendly first. */
export const EVICTION_POLICIES = [
  'allkeys-lru',
  'allkeys-lfu',
  'allkeys-random',
  'volatile-lru',
  'volatile-lfu',
  'volatile-random',
  'volatile-ttl',
  'noeviction',
] as const;
export type EvictionPolicy = (typeof EVICTION_POLICIES)[number];

export interface ValkeyCacheSpec {
  /** Which of the Project's locations the cache runs in; fixed after creation. */
  site?: Site;
  mode?: CacheMode;
  shards?: number;
  replicas?: number;
  resources?: { cpu?: string; memory?: string };
  maxMemoryPercent?: number;
  evictionPolicy?: EvictionPolicy;
  monitoring?: {
    enabled?: boolean;
    prometheusRule?: { enabled?: boolean; excludeRules?: string[] };
    grafanaDashboard?: { enabled?: boolean };
  };
}

export interface ValkeyCacheStatus {
  ready?: boolean;
  /** The ValkeyCluster's state: Initializing, Reconciling, Ready, Degraded, Failed (Pending before it exists). */
  state?: string;
  message?: string;
  shards?: number;
  readyShards?: number;
  site?: Site;
  location?: string;
  endpoint?: string;
  secret?: string;
  modules?: string[];
  monitoring?: { dashboardUid?: string };
  conditions?: Condition[];
}

export interface ValkeyCache {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec: ValkeyCacheSpec;
  status?: ValkeyCacheStatus;
}

/** One row in the portal's cache list. */
export interface ValkeyCacheSummary {
  name: string;
  namespace: string;
  mode: CacheMode;
  shards: number;
  replicas: number;
  readyShards: number;
  cpu: string;
  memory: string;
  maxMemoryPercent: number;
  evictionPolicy: EvictionPolicy;
  monitoring: boolean;
  state: string;
  /** Crossplane's Ready condition: every composed object exists and the operator reports Ready. */
  ready: boolean;
  synced: boolean;
  deleting: boolean;
  message?: string;
  owner?: string;
  /** spec.site: the Project's protected (default) or recovery location. */
  site: Site;
  /** The location the cache runs in; the Project's location for its site until the composition pins it. */
  location: string;
  /** host:port of the cluster's Service in the location. */
  endpoint?: string;
  /** Secret on the control plane (and, as <secret>-auth, in the location) with the password and uri. */
  secret?: string;
  /** Alerts (PrometheusRule) on; needs monitoring. */
  alerts: boolean;
  /** uid of the composed GrafanaDashboard; unset when the dashboard is disabled. */
  dashboardUid?: string;
  createdAt?: string;
  /** The Project whose namespace the cache lives in, if any (filled in by the backend). */
  project?: string;
  /** That project's Grafana (status.grafana.url); filled in by the backend. */
  grafanaUrl?: string;
}

/** The detail page: the cache plus its pods and events in the location. */
export interface ValkeyCacheDetails {
  summary: ValkeyCacheSummary;
  resource: ValkeyCache;
  pods: InstancePod[];
  events: ClusterEvent[];
  /** Set when the location's pods and events couldn't be read. */
  unreachable?: string;
}

/** valkey://default:<password>@host:6379, read from the copy in the location. */
export interface CacheConnection {
  uri: string;
  location: string;
}

/** The pods a cache runs (the operator's label on every Valkey pod). */
export const cacheLabelSelector = (name: string) => `valkey.io/cluster=${name}`;

/** `project` (the cache's, if known) fills in its location until the composition reports it. */
export function summarizeCache(cache: ValkeyCache, project?: Project): ValkeyCacheSummary {
  const { metadata, spec, status } = cache;
  const condition = (type: string) => status?.conditions?.find(c => c.type === type)?.status === 'True';
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    mode: spec.mode ?? 'exact',
    shards: spec.shards ?? 1,
    replicas: spec.replicas ?? 1,
    readyShards: status?.readyShards ?? 0,
    cpu: spec.resources?.cpu ?? '500m',
    memory: spec.resources?.memory ?? '1Gi',
    maxMemoryPercent: spec.maxMemoryPercent ?? 75,
    evictionPolicy: spec.evictionPolicy ?? 'allkeys-lru',
    monitoring: spec.monitoring?.enabled ?? true,
    alerts: (spec.monitoring?.enabled ?? true) && (spec.monitoring?.prometheusRule?.enabled ?? true),
    dashboardUid: status?.monitoring?.dashboardUid || undefined,
    state: status?.state ?? 'Pending',
    ready: condition('Ready'),
    synced: condition('Synced'),
    deleting: Boolean(metadata.deletionTimestamp),
    message: status?.message,
    owner: metadata.labels?.['backstage.io/owner'],
    site: spec.site ?? 'protected',
    location: status?.location || project?.spec.locations?.[spec.site ?? 'protected'] || '',
    endpoint: status?.endpoint || undefined,
    secret: status?.secret || undefined,
    createdAt: metadata.creationTimestamp,
  };
}

/** Pods across all shards: shards × (1 + replicas). */
export const cachePods = (c: Pick<ValkeyCacheSummary, 'shards' | 'replicas'>) => c.shards * (1 + c.replicas);

/** maxmemory as the composition computes it, e.g. "768 MiB" for 1Gi at 75%. */
export function cacheMaxMemory(memory: string, percent: number): string | undefined {
  const m = /^([0-9]+)(Mi|Gi)$/.exec(memory);
  if (!m) return undefined;
  const mi = Number(m[1]) * (m[2] === 'Gi' ? 1024 : 1);
  return `${Math.floor((mi * percent) / 100)} MiB`;
}
