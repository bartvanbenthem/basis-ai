import { PostgresCluster, Project } from '@internal/backstage-plugin-basis-common';
import { AuditCore, AuditService } from './AuditService';

const demo: Project = {
  apiVersion: 'platform.cndev.nl/v1alpha1',
  kind: 'Project',
  metadata: { name: 'demo' },
  spec: { locations: { protected: 'prod-ams' } },
};

const cluster = (name: string, parameters?: Record<string, string>): PostgresCluster =>
  ({
    apiVersion: 'postgres.cndev.nl/v1alpha1',
    kind: 'PostgresCluster',
    metadata: { name, namespace: 'demo' },
    spec: parameters ? { postgresql: { parameters } } : {},
    status: { locations: [{ location: 'prod-ams', role: 'primary' }] },
  }) as PostgresCluster;

const event = (name: string, kind: string, reason: string, at: string, extra: object = {}) => ({
  involvedObject: { kind, name },
  reason,
  message: `${reason} ${name}`,
  type: 'Normal',
  count: 1,
  lastTimestamp: new Date(at),
  source: { component: 'cloudnative-pg' },
  ...extra,
});

const auditLine = JSON.stringify({
  level: 'info',
  ts: '2026-10-07T09:30:00Z',
  logger: 'pgaudit',
  msg: 'record',
  logging_pod: 'orders-db-1',
  record: {
    log_time: '2026-10-07 09:30:00.000 UTC',
    user_name: 'app',
    database_name: 'orders',
    audit: { class: 'DDL', command: 'DROP TABLE', object_name: 'public.old', statement: 'DROP TABLE old' },
  },
});

function fakeCore(events: object[], log = ''): jest.Mocked<AuditCore> {
  return {
    listNamespacedEvent: jest.fn(async ({ namespace }: { namespace: string }) => ({
      items: namespace === 'default' ? [event('demo', 'Project', 'ComposeResources', '2026-10-07T09:00:00Z')] : events,
    })),
    listNamespacedPod: jest.fn(async () => ({ items: [{ metadata: { name: 'orders-db-1' } }] })),
    readNamespacedPodLog: jest.fn(async () => log),
  } as unknown as jest.Mocked<AuditCore>;
}

function setup(clusters: PostgresCluster[], location = fakeCore([], '')) {
  const controlPlane = fakeCore([event('orders-db', 'PostgresCluster', 'SelectComposition', '2026-10-07T09:10:00Z')]);
  const coreFor = jest.fn(async (l: string) => {
    if (l !== 'prod-ams') throw new Error('connection refused');
    return location;
  });
  const service = new AuditService({
    getProject: async () => demo,
    listClusters: async () => clusters,
    controlPlane,
    coreFor,
  });
  return { service, controlPlane, location, coreFor };
}

describe('AuditService', () => {
  it('merges events and pgaudit records, newest first', async () => {
    const location = fakeCore(
      [event('orders-db-2', 'Pod', 'Killing', '2026-10-07T09:20:00Z', { type: 'Warning', count: 3 })],
      `{"level":"info","logger":"postgres","msg":"record"}\n${auditLine}\n`,
    );
    const { service } = setup([cluster('orders-db', { 'pgaudit.log': 'ddl' }), cluster('orders')], location);
    const log = await service.list({ project: 'demo', tailLines: 100 });

    expect(log.items.map(i => [i.source, i.location, i.cluster, i.action])).toEqual([
      ['postgresql', 'prod-ams', 'orders-db', 'DROP TABLE'],
      ['kubernetes', 'prod-ams', 'orders-db', 'Killing'],
      ['kubernetes', 'control-plane', 'orders-db', 'SelectComposition'],
      ['kubernetes', 'control-plane', undefined, 'ComposeResources'],
    ]);
    expect(log.items[1]).toMatchObject({ type: 'Warning', count: 3, actor: 'cloudnative-pg', object: 'Pod/orders-db-2' });
    expect(log.items[0]).toMatchObject({ actor: 'app@orders', instance: 'orders-db-1', type: 'DDL' });
    expect(log.clusters).toEqual([
      { name: 'orders-db', pgauditLog: 'ddl' },
      { name: 'orders', pgauditLog: undefined },
    ]);
    expect(log.unreachable).toBeUndefined();
    // Only the cluster with pgaudit on has its instance logs read.
    expect(location.listNamespacedPod).toHaveBeenCalledTimes(1);
    expect(location.listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'demo',
      labelSelector: 'cnpg.io/cluster=orders-db,cnpg.io/podRole=instance',
    });
    expect(location.readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'demo', name: 'orders-db-1', container: 'postgres', tailLines: 100 }),
    );
  });

  it('takes pgaudit.log from the size when the cluster sets none', async () => {
    const sized = { ...cluster('orders-db'), status: { sizing: { parameters: { 'pgaudit.log': 'role' } } } } as PostgresCluster;
    const { service } = setup([sized]);
    expect((await service.list({ project: 'demo', tailLines: 10 })).clusters).toEqual([
      { name: 'orders-db', pgauditLog: 'role' },
    ]);
  });

  it('reports a location it cannot read and keeps the rest', async () => {
    const recovery = { ...demo, spec: { locations: { protected: 'prod-ams', recovery: 'prod-rtm' } } };
    const { controlPlane, location } = setup([]);
    const service = new AuditService({
      getProject: async () => recovery,
      listClusters: async () => [],
      controlPlane,
      coreFor: async l => {
        if (l === 'prod-rtm') throw new Error('connection refused');
        return location;
      },
    });
    const log = await service.list({ project: 'demo', tailLines: 10 });
    expect(log.unreachable).toEqual([{ location: 'prod-rtm', message: 'connection refused' }]);
    expect(log.items.length).toBe(2);
  });
});
