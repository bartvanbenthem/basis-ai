import { mockServices } from '@backstage/backend-test-utils';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '@backstage/errors';
import { ApiException } from '@kubernetes/client-node';
import { Project } from '@internal/backstage-plugin-basis-common';
import { BucketService, BucketsConfig } from './BucketService';
import { ObjectStore, StoredObject } from './objectStore';

const UID = '77f55a62-5704-4ee2-8f85-c7bf5f2db926';
const LIVE = `project-demo-backups${UID}`;
const ORPHAN = `project-old-backups${UID.replace('77', '88')}`;
const TEST = `cosi-test-bucketclass${UID.replace('77', '99')}`;
const OTHER = 'bck01-usr001-grp01';

const CONFIG: BucketsConfig = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-01',
  secret: { namespace: 'cloudian-cosi', name: 'cloudian-cosi-secret' },
};

const demo: Project = {
  apiVersion: 'platform.cndev.nl/v1alpha1',
  kind: 'Project',
  metadata: { name: 'demo' },
  spec: {},
  status: {
    backup: {
      bucket: LIVE,
      servers: [
        { serverName: 'orders-db', cluster: 'orders-db', active: true },
        { serverName: 'gone-db', cluster: 'gone-db', active: false },
      ],
    },
  },
};

const objects: Record<string, StoredObject[]> = {
  [LIVE]: [
    { key: 'barman/orders-db/base/1/data.tar', size: 100, lastModified: '2026-10-08T10:00:00.000Z' },
    { key: 'barman/orders-db/wals/0001/000000010000000000000001', size: 16, lastModified: '2026-10-08T11:00:00.000Z' },
    { key: 'barman/gone-db/base/1/data.tar', size: 50, lastModified: '2026-10-01T10:00:00.000Z' },
    { key: 'readme.txt', size: 4 },
  ],
  [ORPHAN]: [{ key: 'barman/x/base/1/data.tar', size: 10 }],
  [TEST]: [],
  [OTHER]: [],
};

function fakeStore(): jest.Mocked<ObjectStore> {
  return {
    endpoint: CONFIG.endpoint,
    listBuckets: jest.fn(async () => Object.keys(objects).map(name => ({ name, createdAt: '2026-10-08T09:00:00.000Z' }))),
    listObjects: jest.fn(async (bucket: string, limit: number) => ({
      objects: objects[bucket].slice(0, limit),
      truncated: objects[bucket].length > limit,
    })),
    deleteBucket: jest.fn(async (_bucket: string) => undefined),
  };
}

function setup(options: { config?: BucketsConfig | null; cosi?: unknown[] | Error } = {}) {
  const store = fakeStore();
  const core = {
    readNamespacedSecret: jest.fn(async () => ({
      data: { S3_ACCESS_KEY: Buffer.from('ak').toString('base64'), S3_SECRET_KEY: Buffer.from('sk').toString('base64') },
    })),
  };
  const cosi = options.cosi ?? [
    { metadata: { name: TEST }, spec: { bucketClaim: { namespace: 'zs3-cosi-test', name: 'claim-1' } } },
    {
      metadata: { name: LIVE, creationTimestamp: '2026-10-01T09:00:00Z' },
      status: { bucketID: LIVE },
      spec: { bucketClaim: { namespace: 'demo', name: 'backups' } },
    },
  ];
  const custom = {
    listClusterCustomObject: jest.fn(async () => {
      if (cosi instanceof Error) throw cosi;
      return { items: cosi };
    }),
  };
  const storeFactory = jest.fn(() => store);
  const service = new BucketService({
    core: core as any,
    custom: custom as any,
    listProjects: async () => [demo],
    config: options.config === null ? undefined : options.config ?? CONFIG,
    logger: mockServices.logger.mock(),
    storeFactory,
  });
  return { service, store, core, storeFactory };
}

describe('BucketService', () => {
  it('lists every bucket with what uses it', async () => {
    const { service, storeFactory } = setup();
    const { configured, items, storeError } = await service.list();
    expect(configured).toBe(true);
    expect(storeError).toBeUndefined();
    expect(storeFactory).toHaveBeenCalledWith(CONFIG, { accessKeyId: 'ak', secretAccessKey: 'sk' });
    expect(items.map(b => [b.name, b.state, b.project ?? b.formerProject ?? b.cosiBucket])).toEqual([
      [OTHER, 'orphaned', undefined],
      [TEST, 'cosi', TEST],
      [LIVE, 'project', 'demo'],
      [ORPHAN, 'orphaned', 'old'],
    ]);
    expect(items.find(b => b.name === LIVE)?.usage).toEqual({
      objects: 4,
      bytes: 170,
      lastModified: '2026-10-08T11:00:00.000Z',
    });
  });

  it('reuses usage and keys for a minute', async () => {
    const { service, store, core } = setup();
    await service.list();
    await service.list();
    expect(store.listObjects).toHaveBeenCalledTimes(4);
    expect(core.readNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it('shows a usage error instead of failing the list', async () => {
    const { service, store } = setup();
    store.listObjects.mockRejectedValueOnce(new Error('AccessDenied'));
    const { items } = await service.list();
    expect(items.filter(b => b.usageError)).toHaveLength(1);
  });

  it('treats every bucket as orphaned without COSI CRDs', async () => {
    const { service } = setup({ cosi: new ApiException(404, 'not found', {}, {}) });
    const { items } = await service.list();
    expect(items.find(b => b.name === TEST)?.state).toBe('orphaned');
    // The Project's status still names its bucket.
    expect(items.find(b => b.name === LIVE)?.state).toBe('project');
  });

  it('groups a bucket into folders, with the clusters from the inventory', async () => {
    const { service } = setup();
    const details = await service.get(LIVE);
    expect(details.endpoint).toBe(CONFIG.endpoint);
    expect(details.folders).toEqual([
      { path: '/', objects: 1, bytes: 4, lastModified: undefined },
      { path: 'barman/gone-db', objects: 1, bytes: 50, lastModified: '2026-10-01T10:00:00.000Z', cluster: 'gone-db', active: false },
      { path: 'barman/orders-db', objects: 2, bytes: 116, lastModified: '2026-10-08T11:00:00.000Z', cluster: 'orders-db', active: true },
    ]);
  });

  it('404s an unknown bucket', async () => {
    const { service } = setup();
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.delete('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletes only orphaned buckets', async () => {
    const { service, store } = setup();
    await expect(service.delete(LIVE)).rejects.toThrow(ConflictError);
    await expect(service.delete(LIVE)).rejects.toThrow(/project demo's backup bucket/);
    await expect(service.delete(TEST)).rejects.toThrow(/delete its BucketClaim/);
    expect(store.deleteBucket).not.toHaveBeenCalled();
    await service.delete(ORPHAN);
    expect(store.deleteBucket).toHaveBeenCalledWith(ORPHAN);
  });

  it('lists the buckets the cluster knows when the store is unreachable', async () => {
    const { service, store } = setup();
    store.listBuckets.mockRejectedValue(new Error('Connection timed out after 1000 ms'));
    const { configured, items, storeError } = await service.list();
    expect(configured).toBe(true);
    expect(storeError).toMatch(/s3\.example\.com can't be read: Connection timed out/);
    expect(items.map(b => [b.name, b.state, b.createdAt, b.usage])).toEqual([
      [TEST, 'cosi', undefined, undefined],
      [LIVE, 'project', '2026-10-01T09:00:00Z', undefined],
    ]);
    expect(store.listObjects).not.toHaveBeenCalled();
  });

  it('shows a known bucket without the store, and 503s an unknown one', async () => {
    const { service, store } = setup();
    store.listBuckets.mockRejectedValue(new Error('ECONNREFUSED'));
    const details = await service.get(LIVE);
    expect(details.summary).toMatchObject({ name: LIVE, state: 'project', project: 'demo' });
    expect(details.folders).toEqual([]);
    expect(details.storeError).toMatch(/ECONNREFUSED/);
    await expect(service.get(ORPHAN)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('lists the cluster\'s buckets without configuration, but deletes nothing', async () => {
    const { service, storeFactory } = setup({ config: null });
    expect(service.configured).toBe(false);
    const { configured, items, storeError } = await service.list();
    expect(configured).toBe(false);
    expect(storeError).toMatch(/No object store configured/);
    expect(items.map(b => b.name)).toEqual([TEST, LIVE]);
    expect(storeFactory).not.toHaveBeenCalled();
    await expect(service.delete(ORPHAN)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('says which key the credentials Secret lacks', async () => {
    const { service, core } = setup();
    core.readNamespacedSecret.mockResolvedValueOnce({ data: { S3_ACCESS_KEY: 'YWs=' } } as any);
    const { storeError } = await service.list();
    expect(storeError).toMatch(/has no S3_SECRET_KEY/);
  });
});
