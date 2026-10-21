import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { createPostgresClusterAction, createProjectAction, createValkeyCacheAction, prune } from './scaffolder';

describe('cnpg:valkeycache:create', () => {
  it('applies the cache in the project and outputs links', async () => {
    const valkey = { apply: jest.fn(async () => ({})) };
    const action = createValkeyCacheAction(valkey as any);
    const ctx = createMockActionContext({
      input: {
        name: 'llm-cache',
        namespace: 'resource:default/demo',
        owner: 'group:default/team-ai',
        spec: { mode: 'semantic', shards: 1, replicas: 0, monitoring: { podMonitorLabels: {} } },
      },
    });
    await action.handler(ctx);
    expect(valkey.apply).toHaveBeenCalledWith({
      name: 'llm-cache',
      namespace: 'demo',
      spec: { mode: 'semantic', shards: 1, replicas: 0 },
      labels: { 'backstage.io/owner': 'team-ai' },
      createOnly: true,
      dryRun: undefined,
    });
    expect(ctx.output).toHaveBeenCalledWith('portalPath', '/cnpg/caches/demo/llm-cache');
    expect(ctx.output).toHaveBeenCalledWith('entityRef', 'resource:default/demo--llm-cache.valkey');
  });
});

describe('cnpg:postgrescluster:create', () => {
  it('prunes empty optional values', () => {
    expect(
      prune({
        instances: 3,
        pooler: { enabled: false },
        backup: { enabled: false, destinationPath: '', endpointURL: undefined, s3Credentials: { secretName: '' } },
        labels: [],
      }),
    ).toEqual({ instances: 3, pooler: { enabled: false }, backup: { enabled: false }, labels: [] });
  });

  it('applies the cluster with owner/system labels and outputs links', async () => {
    const k8s = { apply: jest.fn(async () => ({})) };
    const action = createPostgresClusterAction(k8s as any);
    const ctx = createMockActionContext({
      input: {
        name: 'orders-db',
        namespace: 'demo',
        owner: 'group:default/team-orders',
        system: 'system:default/orders',
        spec: { instances: 3, backup: { enabled: false, destinationPath: '' } },
      },
    });
    await action.handler(ctx);
    expect(k8s.apply).toHaveBeenCalledWith({
      name: 'orders-db',
      namespace: 'demo',
      spec: { instances: 3, backup: { enabled: false } },
      labels: { 'backstage.io/owner': 'team-orders', 'backstage.io/system': 'orders' },
      createOnly: true,
      dryRun: undefined,
    });
    expect(ctx.output).toHaveBeenCalledWith('portalPath', '/cnpg/demo/orders-db');
    expect(ctx.output).toHaveBeenCalledWith('entityRef', 'resource:default/demo--orders-db');
  });

  it('takes the namespace from a project entity ref', async () => {
    const k8s = { apply: jest.fn(async () => ({})) };
    const action = createPostgresClusterAction(k8s as any);
    const ctx = createMockActionContext({
      input: { name: 'orders-db', namespace: 'resource:default/team-orders', spec: {} },
    });
    await action.handler(ctx);
    expect(k8s.apply).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'team-orders' }));
    expect(ctx.output).toHaveBeenCalledWith('namespace', 'team-orders');
    expect(ctx.output).toHaveBeenCalledWith('entityRef', 'resource:default/team-orders--orders-db');
  });
});

describe('cnpg:project:create', () => {
  it('applies the project and drops empty access entries and quota', async () => {
    const k8s = { applyProject: jest.fn(async () => ({})) };
    const action = createProjectAction(k8s as any);
    const ctx = createMockActionContext({
      input: {
        name: 'team-orders',
        owner: 'group:default/team-orders',
        description: 'Orders',
        spec: {
          access: [
            { group: 'orders-devs', role: 'edit' },
            { group: '', role: '' },
          ],
          quota: { cpu: '', memory: '', storage: '' },
          observability: { prometheus: { retention: '7d' }, grafana: { ingress: true } },
        },
      },
    });
    await action.handler(ctx);
    expect(k8s.applyProject).toHaveBeenCalledWith({
      name: 'team-orders',
      spec: {
        access: [{ group: 'orders-devs', role: 'edit' }],
        observability: { prometheus: { retention: '7d' }, grafana: { ingress: true } },
        owner: 'team-orders',
        description: 'Orders',
      },
      labels: { 'backstage.io/owner': 'team-orders' },
      createOnly: true,
      dryRun: undefined,
    });
    expect(ctx.output).toHaveBeenCalledWith('entityRef', 'resource:default/team-orders');
    expect(ctx.output).toHaveBeenCalledWith('portalPath', '/cnpg/projects/team-orders');
  });
});
