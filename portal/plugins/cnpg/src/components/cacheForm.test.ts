import { cacheMaxMemory, type ValkeyCache } from '@internal/backstage-plugin-cnpg-common';
import { defaultCacheForm, fromCache, toCacheEditPatch, toCacheSpec, validateCache } from './cacheForm';

describe('cacheForm', () => {
  it('presets a single node for semantic caches (plain clients reach the primary)', () => {
    expect(defaultCacheForm('semantic')).toMatchObject({ mode: 'semantic', shards: 1, replicas: 0 });
    expect(defaultCacheForm()).toMatchObject({ mode: 'exact', shards: 1, replicas: 1 });
  });

  it('mirrors the XRD rules', () => {
    const errors = validateCache({
      ...defaultCacheForm(),
      name: 'Bad_Name',
      shards: 0,
      replicas: 6,
      cpu: 'lots',
      memory: '1G',
      maxMemoryPercent: 95,
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['cpu', 'maxMemoryPercent', 'memory', 'name', 'namespace', 'replicas', 'shards'].sort(),
    );
    expect(validateCache({ ...defaultCacheForm(), name: 'llm-cache', namespace: 'demo' })).toEqual({});
  });

  it('round-trips a cache and patches only what changed', () => {
    const cache: ValkeyCache = {
      apiVersion: 'cache.cndev.nl/v1alpha1',
      kind: 'ValkeyCache',
      metadata: { name: 'llm-cache', namespace: 'demo', labels: { 'backstage.io/owner': 'team-ai' } },
      spec: { mode: 'semantic', shards: 1, replicas: 0, resources: { cpu: '1', memory: '2Gi' } },
    };
    const original = fromCache(cache);
    expect(original).toMatchObject({ owner: 'team-ai', memory: '2Gi', maxMemoryPercent: 75, evictionPolicy: 'allkeys-lru' });
    expect(toCacheSpec(original)).toMatchObject({ mode: 'semantic', resources: { cpu: '1', memory: '2Gi' } });
    expect(toCacheEditPatch(original, original)).toEqual({});
    expect(toCacheEditPatch(original, { ...original, replicas: 1, memory: '4Gi' })).toEqual({
      replicas: 1,
      resources: { memory: '4Gi' },
    });
    expect(toCacheEditPatch(original, { ...original, dashboard: false })).toEqual({
      monitoring: { grafanaDashboard: { enabled: false } },
    });
  });

  it('computes maxmemory as the composition does', () => {
    expect(cacheMaxMemory('1Gi', 75)).toBe('768 MiB');
    expect(cacheMaxMemory('2Gi', 60)).toBe('1228 MiB');
    expect(cacheMaxMemory('1G', 75)).toBeUndefined();
  });
});
