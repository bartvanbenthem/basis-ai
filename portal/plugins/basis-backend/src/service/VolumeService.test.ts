import { mockServices } from '@backstage/backend-test-utils';
import { ConflictError, NotFoundError } from '@backstage/errors';
import { PostgresCluster, Project } from '@internal/backstage-plugin-basis-common';
import { LocationCore, VolumeService } from './VolumeService';

const demo: Project = {
  apiVersion: 'platform.cndev.nl/v1alpha1',
  kind: 'Project',
  metadata: { name: 'demo' },
  spec: { locations: { protected: 'prod-ams' } },
};

const ordersDb: PostgresCluster = {
  apiVersion: 'postgres.cndev.nl/v1alpha1',
  kind: 'PostgresCluster',
  metadata: { name: 'orders-db', namespace: 'demo' },
  spec: { location: 'prod-ams' },
  status: { locations: [{ location: 'prod-ams', role: 'primary' }] },
} as PostgresCluster;

const claim = (name: string, cluster: string, volumeName: string, role = 'PG_DATA') => ({
  metadata: {
    name,
    namespace: 'demo',
    creationTimestamp: new Date('2026-10-01T00:00:00Z'),
    labels: { 'cnpg.io/cluster': cluster, 'cnpg.io/instanceName': name.replace(/-wal$/, ''), 'cnpg.io/pvcRole': role },
  },
  spec: { volumeName, storageClassName: 'fast', resources: { requests: { storage: '20Gi' } } },
  status: { phase: 'Bound', capacity: { storage: '20Gi' } },
});

const pv = (name: string, claimName: string, phase: string, policy = 'Delete') => ({
  metadata: { name },
  spec: {
    claimRef: { namespace: 'demo', name: claimName },
    capacity: { storage: '20Gi' },
    persistentVolumeReclaimPolicy: policy,
    csi: { driver: 'disk.csi.example.com' },
  },
  status: { phase },
});

function fakeCore(): jest.Mocked<LocationCore> {
  return {
    listNamespacedPersistentVolumeClaim: jest.fn(async () => ({
      items: [claim('orders-db-1', 'orders-db', 'pv-1'), claim('gone-db-1', 'gone-db', 'pv-2')],
    })),
    listPersistentVolume: jest.fn(async () => ({
      items: [
        pv('pv-1', 'orders-db-1', 'Bound'),
        pv('pv-2', 'gone-db-1', 'Bound', 'Retain'),
        pv('pv-3', 'old-db-1-wal', 'Released', 'Retain'),
        // Not CNPG's, and not in a project namespace: left out.
        pv('pv-4', 'redis-data', 'Released', 'Retain'),
        { ...pv('pv-5', 'x-db-1', 'Released'), spec: { ...pv('pv-5', 'x-db-1', 'Released').spec, claimRef: { namespace: 'other', name: 'x-db-1' } } },
      ],
    })),
    listNamespacedPod: jest.fn(async () => ({
      items: [
        {
          metadata: { name: 'orders-db-1', namespace: 'demo' },
          spec: { nodeName: 'node-a', volumes: [{ name: 'pgdata', persistentVolumeClaim: { claimName: 'orders-db-1' } }] },
          status: { phase: 'Running' },
        },
      ],
    })),
    connectGetNodeProxyWithPath: jest.fn(async () =>
      JSON.stringify({
        pods: [{ volume: [{ usedBytes: 5_000, capacityBytes: 20_000, pvcRef: { name: 'orders-db-1', namespace: 'demo' } }] }],
      }),
    ),
    deleteNamespacedPersistentVolumeClaim: jest.fn(async () => ({})),
    deletePersistentVolume: jest.fn(async () => ({})),
    patchPersistentVolume: jest.fn(async () => ({})),
  } as unknown as jest.Mocked<LocationCore>;
}

function setup(core = fakeCore(), clusters = [ordersDb]) {
  const service = new VolumeService({
    listProjects: async () => [demo],
    listClusters: async () => clusters,
    coreFor: async location => {
      if (location !== 'prod-ams') throw new Error('unknown location');
      return core;
    },
    logger: mockServices.logger.mock(),
  });
  return { service, core };
}

describe('VolumeService', () => {
  it('lists the claims of each project with their state, volume and usage', async () => {
    const { service, core } = setup();
    const { items, unreachable } = await service.list();
    expect(unreachable).toBeUndefined();
    expect(core.listNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({ namespace: 'demo', labelSelector: 'cnpg.io/cluster' });
    expect(items.map(v => [v.claim, v.state])).toEqual([
      ['gone-db-1', 'orphaned'],
      ['old-db-1-wal', 'released'],
      ['orders-db-1', 'in-use'],
    ]);
    expect(items.find(v => v.claim === 'orders-db-1')).toMatchObject({
      location: 'prod-ams',
      project: 'demo',
      volume: 'pv-1',
      cluster: 'orders-db',
      instance: 'orders-db-1',
      role: 'data',
      capacity: '20Gi',
      usedBytes: 5_000,
      capacityBytes: 20_000,
      pod: 'orders-db-1',
      node: 'node-a',
      driver: 'disk.csi.example.com',
      reclaimPolicy: 'Delete',
    });
    expect(items.find(v => v.state === 'released')).toMatchObject({
      volume: 'pv-3',
      cluster: 'old-db',
      instance: 'old-db-1',
      role: 'wal',
      reclaimPolicy: 'Retain',
    });
  });

  it('reports a location it cannot reach instead of failing', async () => {
    const service = new VolumeService({
      listProjects: async () => [{ ...demo, spec: { locations: { protected: 'prod-ams', recovery: 'dr-rtm' } } }],
      listClusters: async () => [ordersDb],
      coreFor: async location => {
        if (location === 'dr-rtm') throw new Error('connection refused');
        return fakeCore();
      },
      logger: mockServices.logger.mock(),
    });
    const res = await service.list();
    expect(res.items).toHaveLength(3);
    expect(res.unreachable).toEqual([{ location: 'dr-rtm', message: 'connection refused' }]);
  });

  it('filters on a project', async () => {
    const { service } = setup();
    expect((await service.list({ project: 'other' })).items).toEqual([]);
  });

  it('deletes an orphaned claim, switching a retained volume to Delete first', async () => {
    const { service, core } = setup();
    await service.deleteClaim('prod-ams', 'demo', 'gone-db-1');
    expect(core.patchPersistentVolume).toHaveBeenCalledWith({
      name: 'pv-2',
      body: [{ op: 'replace', path: '/spec/persistentVolumeReclaimPolicy', value: 'Delete' }],
    });
    expect(core.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({ namespace: 'demo', name: 'gone-db-1' });
  });

  it('refuses to delete a claim in use', async () => {
    const { service, core } = setup();
    await expect(service.deleteClaim('prod-ams', 'demo', 'orders-db-1')).rejects.toThrow(ConflictError);
    expect(core.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('refuses a claim whose cluster still runs there, even when no pod mounts it', async () => {
    const core = fakeCore();
    core.listNamespacedPod.mockResolvedValue({ items: [] } as any);
    const { service } = setup(core);
    await expect(service.deleteClaim('prod-ams', 'demo', 'orders-db-1')).rejects.toThrow(
      'PostgresCluster demo/orders-db still runs in prod-ams',
    );
  });

  it('refuses a claim mounted by a pod, even when its cluster is gone', async () => {
    const { service } = setup(fakeCore(), []);
    await expect(service.deleteClaim('prod-ams', 'demo', 'orders-db-1')).rejects.toThrow('pod orders-db-1 mounts it');
  });

  it('does not delete outside the project locations', async () => {
    const { service } = setup();
    await expect(service.deleteClaim('dr-rtm', 'demo', 'gone-db-1')).rejects.toThrow(NotFoundError);
    await expect(service.deleteClaim('prod-ams', 'demo', 'nope-1')).rejects.toThrow(NotFoundError);
  });

  it('reclaims a released volume by switching it to Delete', async () => {
    const { service, core } = setup();
    await service.deleteVolume('prod-ams', 'pv-3');
    expect(core.patchPersistentVolume).toHaveBeenCalledWith(expect.objectContaining({ name: 'pv-3' }));
    expect(core.deletePersistentVolume).not.toHaveBeenCalled();
  });

  it('only deletes released volumes of project namespaces', async () => {
    const { service, core } = setup();
    await expect(service.deleteVolume('prod-ams', 'pv-1')).rejects.toThrow(ConflictError);
    await expect(service.deleteVolume('prod-ams', 'pv-2')).rejects.toThrow(ConflictError);
    await expect(service.deleteVolume('prod-ams', 'pv-4')).rejects.toThrow(NotFoundError);
    await expect(service.deleteVolume('prod-ams', 'pv-5')).rejects.toThrow(NotFoundError);
    expect(core.patchPersistentVolume).not.toHaveBeenCalled();
  });
});
