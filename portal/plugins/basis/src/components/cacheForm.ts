/**
 * Create/edit-cache form state and its mapping onto a ValkeyCache spec. Like
 * form.ts: the fields mirror the XRD, which (with the admission policy) has
 * the final say.
 */

import {
  CACHE_GROUP,
  CACHE_KIND,
  CACHE_VERSION,
  type CacheMode,
  type EvictionPolicy,
  type Site,
  type ValkeyCache,
} from '@internal/backstage-plugin-basis-common';
import { mergePatch } from './form';

export interface CacheForm {
  name: string;
  namespace: string;
  owner: string;
  /** Which of the project's locations; fixed after creation. */
  site: Site;
  /** Fixed after creation. */
  mode: CacheMode;
  shards: number;
  replicas: number;
  cpu: string;
  memory: string;
  maxMemoryPercent: number;
  evictionPolicy: EvictionPolicy;
  monitoring: boolean;
  /** PrometheusRule with the cache alerts; needs monitoring. */
  alerts: boolean;
  /** GrafanaDashboard in the project's Grafana. */
  dashboard: boolean;
}

export const defaultCacheForm = (mode: CacheMode = 'exact'): CacheForm => ({
  name: '',
  namespace: '',
  owner: '',
  site: 'protected',
  mode,
  // A semantic cache is usually fed to a client without cluster support
  // (LiteLLM's valkey-semantic): one node keeps the Service on the primary.
  shards: 1,
  replicas: mode === 'semantic' ? 0 : 1,
  cpu: mode === 'semantic' ? '1' : '500m',
  memory: '1Gi',
  maxMemoryPercent: 75,
  evictionPolicy: 'allkeys-lru',
  monitoring: true,
  alerts: true,
  dashboard: true,
});

export function fromCache(cache: ValkeyCache): CacheForm {
  const { metadata, spec } = cache;
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    owner: metadata.labels?.['backstage.io/owner'] ?? '',
    site: spec.site ?? 'protected',
    mode: spec.mode ?? 'exact',
    shards: spec.shards ?? 1,
    replicas: spec.replicas ?? 1,
    cpu: spec.resources?.cpu ?? '500m',
    memory: spec.resources?.memory ?? '1Gi',
    maxMemoryPercent: spec.maxMemoryPercent ?? 75,
    evictionPolicy: spec.evictionPolicy ?? 'allkeys-lru',
    monitoring: spec.monitoring?.enabled ?? true,
    alerts: spec.monitoring?.prometheusRule?.enabled ?? true,
    dashboard: spec.monitoring?.grafanaDashboard?.enabled ?? true,
  };
}

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;

/** Field-level errors shown inline; mirrors the XRD's rules. */
export function validateCache(f: CacheForm): Partial<Record<keyof CacheForm, string>> {
  const e: Partial<Record<keyof CacheForm, string>> = {};
  if (!NAME.test(f.name)) e.name = 'Lowercase letters, digits and "-", starting with a letter, max 40 characters.';
  if (!f.namespace) e.namespace = 'Pick the project the cache belongs to.';
  if (f.owner && !/^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/.test(f.owner)) e.owner = 'A group name, e.g. team-payments.';
  if (!Number.isInteger(f.shards) || f.shards < 1 || f.shards > 16) e.shards = '1 to 16';
  if (!Number.isInteger(f.replicas) || f.replicas < 0 || f.replicas > 5) e.replicas = '0 to 5';
  if (!/^[0-9]+(\.[0-9]+)?m?$/.test(f.cpu)) e.cpu = 'e.g. 500m or 2';
  if (!/^[0-9]+(Mi|Gi)$/.test(f.memory)) e.memory = 'e.g. 512Mi or 2Gi';
  if (!Number.isInteger(f.maxMemoryPercent) || f.maxMemoryPercent < 10 || f.maxMemoryPercent > 90) {
    e.maxMemoryPercent = '10 to 90';
  }
  return e;
}

export function toCacheSpec(f: CacheForm): Record<string, unknown> {
  return {
    site: f.site,
    mode: f.mode,
    shards: f.shards,
    replicas: f.replicas,
    resources: { cpu: f.cpu, memory: f.memory },
    maxMemoryPercent: f.maxMemoryPercent,
    evictionPolicy: f.evictionPolicy,
    monitoring: {
      enabled: f.monitoring,
      prometheusRule: { enabled: f.alerts },
      grafanaDashboard: { enabled: f.dashboard },
    },
  };
}

export function toCacheManifest(f: CacheForm) {
  return {
    apiVersion: `${CACHE_GROUP}/${CACHE_VERSION}`,
    kind: CACHE_KIND,
    metadata: {
      name: f.name || '<name>',
      namespace: f.namespace || '<project>',
      ...(f.owner ? { labels: { 'backstage.io/owner': f.owner } } : {}),
    },
    spec: toCacheSpec(f),
  };
}

/** What an edit changes in the spec: a merge patch, empty when nothing changed. */
export function toCacheEditPatch(original: CacheForm, f: CacheForm): Record<string, unknown> {
  return (mergePatch(toCacheSpec(original), toCacheSpec(f)) ?? {}) as Record<string, unknown>;
}
