import { mockServices } from '@backstage/backend-test-utils';
import { PostgresClusterEntityProvider } from './catalog';

describe('PostgresClusterEntityProvider', () => {
  const cluster = {
    apiVersion: 'cnpg.cndev.nl/v1alpha1',
    kind: 'PostgresCluster',
    metadata: {
      name: 'payments-db',
      namespace: 'payments',
      labels: { 'backstage.io/owner': 'team-payments', 'backstage.io/system': 'payments' },
    },
    spec: { postgresVersion: 17, instances: 3 },
    status: { monitoring: { dashboardUid: 'cnpg-abc' } },
  };

  const make = (k8s: any = {}, valkey?: any) =>
    new PostgresClusterEntityProvider(
      k8s,
      { run: jest.fn() } as any,
      mockServices.logger.mock(),
      {
        defaultOwner: 'group:default/guests',
        appBaseUrl: 'https://portal.example.com',
        grafanaUrl: 'https://grafana.example.com/',
      },
      valkey,
    );

  it('maps a PostgresCluster to a Resource entity', () => {
    const entity = make().toEntity(cluster);
    expect(entity).toMatchObject({
      kind: 'Resource',
      metadata: {
        name: 'payments--payments-db',
        title: 'payments-db (payments)',
        annotations: {
          'cnpg.cndev.nl/postgrescluster': 'payments/payments-db',
          'backstage.io/kubernetes-id': 'payments-db',
          'backstage.io/kubernetes-namespace': 'payments',
        },
        tags: ['postgresql', 'cnpg', 'pg17'],
      },
      spec: { type: 'postgres-cluster', owner: 'team-payments', system: 'payments' },
    });
    expect(entity.metadata.links).toContainEqual({
      url: 'https://portal.example.com/cnpg/payments/payments-db',
      title: 'CNPG portal',
    });
    expect(entity.metadata.links).toContainEqual({
      url: 'https://grafana.example.com/d/cnpg-abc',
      title: 'Grafana dashboard',
    });
  });

  it('links a cluster to its project and prefers the project Grafana', () => {
    const entity = make().toEntity(cluster, {
      name: 'payments',
      ready: true,
      synced: true,
      deleting: false,
      deletionProtection: true,
      prometheus: true,
      grafana: true,
      grafanaUrl: 'http://grafana-payments.example.com',
      locations: ['ske'],
    });
    expect(entity.spec?.dependsOn).toEqual(['resource:default/payments']);
    expect(entity.metadata.links).toContainEqual({
      url: 'http://grafana-payments.example.com/d/cnpg-abc',
      title: 'Grafana dashboard',
    });
  });

  it('maps a Project to a project Resource entity', () => {
    const entity = make().toProjectEntity({
      apiVersion: 'platform.cndev.nl/v1alpha1',
      kind: 'Project',
      metadata: { name: 'payments' },
      spec: { owner: 'team-payments', description: 'Payment services' },
      status: { grafana: { url: 'http://grafana-payments.example.com' } },
    });
    expect(entity).toMatchObject({
      kind: 'Resource',
      metadata: {
        name: 'payments',
        description: 'Payment services',
        annotations: {
          'platform.cndev.nl/project': 'payments',
          'backstage.io/kubernetes-namespace': 'payments',
        },
      },
      spec: { type: 'project', owner: 'team-payments' },
    });
    expect(entity.metadata.links).toEqual([
      { url: 'https://portal.example.com/cnpg/projects/payments', title: 'CNPG portal' },
      { url: 'http://grafana-payments.example.com', title: 'Grafana' },
    ]);
  });

  it('maps a ValkeyCache to a valkey-cache Resource that never collides with a cluster', () => {
    const cache = {
      apiVersion: 'cache.cndev.nl/v1alpha1',
      kind: 'ValkeyCache',
      metadata: { name: 'payments-db', namespace: 'payments', labels: { 'backstage.io/owner': 'team-ai' } },
      spec: { mode: 'semantic' as const, shards: 1, replicas: 0 },
      status: { monitoring: { dashboardUid: 'valkey-abc' } },
    };
    const entity = make().toCacheEntity(cache, {
      name: 'payments',
      ready: true,
      synced: true,
      deleting: false,
      deletionProtection: true,
      prometheus: true,
      grafana: true,
      grafanaUrl: 'http://grafana-payments.example.com',
      locations: ['ske'],
    });
    expect(entity).toMatchObject({
      kind: 'Resource',
      metadata: {
        name: 'payments--payments-db.valkey',
        annotations: { 'cache.cndev.nl/valkeycache': 'payments/payments-db' },
        tags: ['valkey', 'cache', 'semantic'],
      },
      spec: { type: 'valkey-cache', owner: 'team-ai', dependsOn: ['resource:default/payments'] },
    });
    expect(entity.metadata.name).not.toBe(make().toEntity(cluster).metadata.name);
    expect(entity.metadata.links).toEqual([
      { url: 'https://portal.example.com/cnpg/caches/payments/payments-db', title: 'CNPG portal' },
      { url: 'http://grafana-payments.example.com/d/valkey-abc', title: 'Grafana dashboard' },
    ]);
  });

  it('falls back to the default owner', () => {
    const entity = make().toEntity({ ...cluster, metadata: { name: 'a', namespace: 'b' } });
    expect(entity.spec?.owner).toBe('group:default/guests');
  });

  it('replaces the full entity set on refresh', async () => {
    const provider = make(
      {
        list: jest.fn(async () => [cluster]),
        listProjects: jest.fn(async () => [
          { apiVersion: 'platform.cndev.nl/v1alpha1', kind: 'Project', metadata: { name: 'payments' }, spec: {} },
        ]),
      },
      {
        list: jest.fn(async () => [
          { apiVersion: 'cache.cndev.nl/v1alpha1', kind: 'ValkeyCache', metadata: { name: 'llm', namespace: 'payments' }, spec: {} },
        ]),
      },
    );
    const connection = { applyMutation: jest.fn(), refresh: jest.fn() };
    await provider.connect(connection);
    await provider.refresh();
    const { entities } = connection.applyMutation.mock.calls[0][0];
    expect(connection.applyMutation.mock.calls[0][0].type).toBe('full');
    expect(entities.map((e: any) => e.entity.metadata.name)).toEqual([
      'payments',
      'payments--payments-db',
      'payments--llm.valkey',
    ]);
    expect(entities.every((e: any) => e.locationKey === 'cnpg-postgresclusters')).toBe(true);
    expect(entities[1].entity.spec.dependsOn).toEqual(['resource:default/payments']);
  });
});
