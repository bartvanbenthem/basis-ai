import { createServiceFactory } from '@backstage/backend-plugin-api';
import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import { NotFoundError } from '@backstage/errors';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import request from 'supertest';
import { cnpgPlugin } from './plugin';
import {
  CnpgKubernetesService,
  cnpgKubernetesServiceRef,
} from './service/CnpgKubernetesService';
import { BucketService, bucketServiceRef } from './service/BucketService';
import { LocationService, locationServiceRef } from './service/LocationService';
import { VolumeService, volumeServiceRef } from './service/VolumeService';
import { AuditService, auditServiceRef } from './service/AuditService';
import { ValkeyService, valkeyServiceRef } from './service/ValkeyService';
import { PostgresCluster, Project, ValkeyCache } from '@internal/backstage-plugin-cnpg-common';

const ordersDb: PostgresCluster = {
  apiVersion: 'cnpg.cndev.nl/v1alpha1',
  kind: 'PostgresCluster',
  metadata: {
    name: 'orders-db',
    namespace: 'demo',
    creationTimestamp: '2026-10-07T08:58:00Z',
    labels: { 'backstage.io/owner': 'team-orders' },
  },
  spec: { postgresVersion: 17, instances: 3, pooler: { enabled: true } },
  status: {
    phase: 'Cluster in healthy state',
    readyInstances: 3,
    currentPrimary: 'orders-db-1',
    conditions: [
      { type: 'Ready', status: 'True' },
      { type: 'Synced', status: 'True' },
    ],
  },
};

const demoProject: Project = {
  apiVersion: 'platform.cndev.nl/v1alpha1',
  kind: 'Project',
  metadata: { name: 'demo', creationTimestamp: '2026-10-07T08:00:00Z' },
  spec: { owner: 'team-demo', deletionProtection: true },
  status: {
    namespace: 'demo',
    grafana: { url: 'http://grafana-demo.example.com' },
    conditions: [
      { type: 'Ready', status: 'True' },
      { type: 'Synced', status: 'True' },
    ],
  },
};

function fakeK8s() {
  return {
    list: jest.fn(async () => [ordersDb]),
    get: jest.fn(async (ns: string, name: string) => {
      if (ns === 'demo' && name === 'orders-db') return ordersDb;
      throw new NotFoundError(`PostgresCluster ${ns}/${name} not found`);
    }),
    details: jest.fn(),
    apply: jest.fn(async (o: any) => ({ ...ordersDb, metadata: { name: o.name, namespace: o.namespace } })),
    delete: jest.fn(async () => undefined),
    namespaces: jest.fn(async () => ['demo', 'payments']),
    listProjects: jest.fn(async () => [demoProject]),
    getProject: jest.fn(async (name: string) => {
      if (name === 'demo') return demoProject;
      throw new NotFoundError(`Project ${name} not found`);
    }),
    applyProject: jest.fn(async (o: any) => ({ ...demoProject, metadata: { name: o.name } })),
    patch: jest.fn(async () => ordersDb),
    patchProject: jest.fn(async () => demoProject),
    extensionsCatalog: jest.fn(async (): Promise<unknown> => ({
      extensions: [
        { name: 'vector', displayName: 'pgvector', description: 'Vector similarity search' },
        { name: 'Bad Name' },
      ],
    })),
    deleteProject: jest.fn(async () => undefined),
    logs: jest.fn(async (_ns: string, _name: string, o: any, _kubeConfigFor?: unknown) => ({
      pod: o.pod,
      location: o.location ?? 'ske',
      container: 'postgres',
      text: '{"level":"info","msg":"hi"}\n',
    })),
  };
}

const prodLocation = {
  name: 'prod-ams',
  spec: { environment: 'production', region: 'ams' },
  connection: { server: 'https://prod:6443', context: 'prod', auth: 'token', insecureSkipTlsVerify: false },
  providerConfig: true,
  health: { status: 'healthy', checkedAt: '2026-10-07T09:00:00Z', checks: [] },
};

function fakeLocations() {
  return {
    list: jest.fn(async () => [prodLocation]),
    get: jest.fn(async (name: string) => {
      if (name === 'prod-ams') return prodLocation;
      throw new NotFoundError(`Location ${name} not found`);
    }),
    test: jest.fn(async () => prodLocation.health),
    create: jest.fn(async (o: any) => ({ ...prodLocation, name: o.name })),
    update: jest.fn(async () => prodLocation),
    delete: jest.fn(async () => undefined),
    kubeConfig: jest.fn(async (name: string) => ({ location: name })),
  };
}

const orphan = {
  name: 'project-old-backups2ebf90a9-7d23-42fb-9739-f775abe51b06',
  state: 'orphaned',
  formerProject: 'old',
  usage: { objects: 3, bytes: 1024 },
};

function fakeBuckets(configured = true) {
  return {
    configured,
    list: jest.fn(async () =>
      configured ? { configured, items: [orphan] } : { configured, items: [], storeError: 'No object store configured' },
    ),
    get: jest.fn(async (name: string) => {
      if (name === orphan.name) return { summary: orphan, endpoint: 'https://s3.example.com', folders: [] };
      throw new NotFoundError(`Bucket ${name} not found`);
    }),
    delete: jest.fn(async () => undefined),
  };
}

const orphanVolume = {
  location: 'prod-ams',
  project: 'demo',
  claim: 'gone-db-1',
  volume: 'pv-2',
  state: 'orphaned',
  phase: 'Bound',
};

function fakeVolumes() {
  return {
    list: jest.fn(async () => ({ items: [orphanVolume] })),
    deleteClaim: jest.fn(async () => undefined),
    deleteVolume: jest.fn(async () => undefined),
  };
}

const llmCache: ValkeyCache = {
  apiVersion: 'cache.cndev.nl/v1alpha1',
  kind: 'ValkeyCache',
  metadata: { name: 'llm-cache', namespace: 'demo', labels: { 'backstage.io/owner': 'team-ai' } },
  spec: { mode: 'semantic', shards: 1, replicas: 0 },
  status: {
    state: 'Ready',
    readyShards: 1,
    location: 'prod-ams',
    endpoint: 'valkey-llm-cache.demo.svc:6379',
    secret: 'llm-cache-valkey',
    conditions: [
      { type: 'Ready', status: 'True' },
      { type: 'Synced', status: 'True' },
    ],
  },
};

function fakeValkey(caches: ValkeyCache[] = []) {
  return {
    list: jest.fn(async (_ns?: string) => caches),
    get: jest.fn(async () => llmCache),
    details: jest.fn(async () => ({ summary: {}, resource: llmCache, pods: [], events: [] })),
    connection: jest.fn(async (_ns: string, _name: string, _kubeConfigFor: unknown) => ({
      uri: 'valkey://default:s3cret@valkey-llm-cache.demo.svc:6379',
      location: 'prod-ams',
    })),
    apply: jest.fn(async (o: any) => ({ ...llmCache, metadata: { name: o.name, namespace: o.namespace } })),
    patch: jest.fn(async () => llmCache),
    delete: jest.fn(async () => undefined),
  };
}

function fakeAudit() {
  return {
    list: jest.fn(async ({ project }: { project: string }) => ({ project, items: [], clusters: [] })),
  };
}

async function start(
  k8s: ReturnType<typeof fakeK8s>,
  allow = true,
  locations = fakeLocations(),
  buckets = fakeBuckets(),
  volumes = fakeVolumes(),
  audit = fakeAudit(),
  valkey = fakeValkey(),
) {
  const { server } = await startTestBackend({
    features: [
      cnpgPlugin,
      createServiceFactory({
        service: cnpgKubernetesServiceRef,
        deps: {},
        factory: () => k8s as unknown as CnpgKubernetesService,
      }),
      createServiceFactory({
        service: locationServiceRef,
        deps: {},
        factory: () => locations as unknown as LocationService,
      }),
      createServiceFactory({
        service: bucketServiceRef,
        deps: {},
        factory: () => buckets as unknown as BucketService,
      }),
      createServiceFactory({
        service: volumeServiceRef,
        deps: {},
        factory: () => volumes as unknown as VolumeService,
      }),
      createServiceFactory({
        service: auditServiceRef,
        deps: {},
        factory: () => audit as unknown as AuditService,
      }),
      createServiceFactory({
        service: valkeyServiceRef,
        deps: {},
        factory: () => valkey as unknown as ValkeyService,
      }),
      mockServices.permissions.factory({
        result: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
      }),
    ],
  });
  return server;
}

describe('cnpg backend', () => {
  it('serves the extension catalog, empty without one', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).get('/api/cnpg/extensions');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { name: 'vector', displayName: 'pgvector', description: 'Vector similarity search', parameters: {} },
    ]);
    k8s.extensionsCatalog.mockResolvedValueOnce(undefined);
    expect((await request(server).get('/api/cnpg/extensions')).body.items).toEqual([]);
  });

  it('lists clusters as summaries', async () => {
    const server = await start(fakeK8s());
    const res = await request(server).get('/api/cnpg/clusters');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        name: 'orders-db',
        namespace: 'demo',
        instances: 3,
        readyInstances: 3,
        ready: true,
        synced: true,
        pooler: true,
        backup: false,
        owner: 'team-orders',
        project: 'demo',
        grafanaUrl: 'http://grafana-demo.example.com',
      }),
    ]);
  });

  it('leaves clusters outside a project without project info', async () => {
    const k8s = fakeK8s();
    k8s.listProjects.mockResolvedValue([]);
    const server = await start(k8s);
    const res = await request(server).get('/api/cnpg/clusters');
    expect(res.body.items[0].project).toBeUndefined();
    expect(res.body.items[0].grafanaUrl).toBeUndefined();
  });

  it('adds the project to cluster details', async () => {
    const k8s = fakeK8s();
    k8s.details.mockResolvedValue({
      summary: { name: 'orders-db', namespace: 'demo' },
      resource: ordersDb,
      pods: [],
      events: [],
    });
    const server = await start(k8s);
    const res = await request(server).get('/api/cnpg/clusters/demo/orders-db');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      project: 'demo',
      grafanaUrl: 'http://grafana-demo.example.com',
    });
  });

  it('reads a cluster in other locations with their kubeconfig', async () => {
    const k8s = fakeK8s();
    const locations = fakeLocations();
    k8s.details.mockImplementation(async (_ns: string, _name: string, kubeConfigFor: any) => ({
      summary: { name: 'orders-db', namespace: 'demo' },
      resource: ordersDb,
      pods: [],
      events: [],
      kc: await kubeConfigFor('prod-ams'),
    }));
    const server = await start(k8s, true, locations);
    const res = await request(server).get('/api/cnpg/clusters/demo/orders-db');
    expect(res.status).toBe(200);
    expect(res.body.kc).toEqual({ location: 'prod-ams' });
    expect(locations.kubeConfig).toHaveBeenCalledWith('prod-ams');
  });

  it('returns pod logs with defaults for the query', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).get('/api/cnpg/clusters/demo/orders-db/logs?pod=orders-db-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pod: 'orders-db-1', container: 'postgres' });
    expect(k8s.logs).toHaveBeenCalledWith(
      'demo',
      'orders-db',
      { pod: 'orders-db-1', tailLines: 500, previous: false },
      expect.any(Function),
    );
  });

  it('passes the location of the pod to the logs', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).get(
      '/api/cnpg/clusters/demo/orders-db/logs?pod=orders-db-1&location=prod-ams',
    );
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('prod-ams');
    expect(k8s.logs.mock.calls[0][2]).toMatchObject({ location: 'prod-ams' });
  });

  it('rejects invalid log queries', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    for (const query of [
      '',
      '?pod=Bad_Pod',
      '?pod=orders-db-1&tailLines=100000',
      '?pod=orders-db-1&location=Not_A_Location',
    ]) {
      const res = await request(server).get(`/api/cnpg/clusters/demo/orders-db/logs${query}`);
      expect(res.status).toBe(400);
    }
    expect(k8s.logs).not.toHaveBeenCalled();
  });

  it('denies logs without read permission', async () => {
    const server = await start(fakeK8s(), false);
    const res = await request(server).get('/api/cnpg/clusters/demo/orders-db/logs?pod=orders-db-1');
    expect(res.status).toBe(403);
  });

  describe('locations', () => {
    it('lists locations with the projects that use them', async () => {
      const k8s = fakeK8s();
      k8s.listProjects.mockResolvedValue([
        demoProject,
        { ...demoProject, metadata: { name: 'ledger' }, spec: { locations: { protected: 'prod-ams' } } },
      ]);
      const server = await start(k8s);
      const res = await request(server).get('/api/cnpg/locations');
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([
        expect.objectContaining({ name: 'prod-ams', projects: ['ledger'] }),
      ]);
    });

    it("won't delete a location a project uses", async () => {
      const k8s = fakeK8s();
      const locations = fakeLocations();
      k8s.listProjects.mockResolvedValue([
        { ...demoProject, metadata: { name: 'ledger' }, spec: { locations: { protected: 'prod-ams' } } },
      ]);
      const server = await start(k8s, true, locations);
      const res = await request(server).delete('/api/cnpg/locations/prod-ams');
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('ledger');
      expect(locations.delete).not.toHaveBeenCalled();
    });

    it('tests a kubeconfig without storing it on dryRun', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      const res = await request(server)
        .post('/api/cnpg/locations')
        .send({ name: 'new-loc', kubeconfig: 'apiVersion: v1', dryRun: true });
      expect(res.status).toBe(200);
      expect(res.body.health.status).toBe('healthy');
      expect(locations.test).toHaveBeenCalledWith({
        name: 'new-loc',
        kubeconfig: 'apiVersion: v1',
        spec: {},
      });
      expect(locations.create).not.toHaveBeenCalled();
    });

    it('creates a location with its settings', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      const res = await request(server)
        .post('/api/cnpg/locations')
        .send({
          name: 'new-loc',
          kubeconfig: 'apiVersion: v1',
          context: 'prod',
          spec: { environment: 'test', provider: 'kind', schedulable: true },
        });
      expect(res.status).toBe(201);
      expect(locations.create).toHaveBeenCalledWith({
        name: 'new-loc',
        kubeconfig: 'apiVersion: v1',
        context: 'prod',
        spec: { environment: 'test', provider: 'kind', schedulable: true },
      });
    });

    it('rejects unknown settings and bad names', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      for (const body of [
        { name: 'Bad_Name', kubeconfig: 'x' },
        { name: 'ok', kubeconfig: 'x', spec: { environment: 'staging' } },
        { name: 'ok', kubeconfig: 'x', spec: { surprise: true } },
        { name: 'ok', kubeconfig: '' },
        { name: 'local', kubeconfig: 'x' },
      ]) {
        const res = await request(server).post('/api/cnpg/locations').send(body);
        expect(res.status).toBe(400);
      }
      expect(locations.create).not.toHaveBeenCalled();
    });

    it('refreshes health on check and maps a missing location to 404', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      expect((await request(server).post('/api/cnpg/locations/prod-ams/check')).status).toBe(200);
      expect(locations.get).toHaveBeenCalledWith('prod-ams', { refresh: true });
      expect((await request(server).get('/api/cnpg/locations/nope')).status).toBe(404);
    });

    it('updates and deletes', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), true, locations);
      const put = await request(server)
        .put('/api/cnpg/locations/prod-ams')
        .send({ spec: { displayName: 'Prod AMS' } });
      expect(put.status).toBe(200);
      expect(locations.update).toHaveBeenCalledWith('prod-ams', { spec: { displayName: 'Prod AMS' } });
      expect((await request(server).delete('/api/cnpg/locations/prod-ams')).status).toBe(200);
    });

    it('needs permission', async () => {
      const locations = fakeLocations();
      const server = await start(fakeK8s(), false, locations);
      expect((await request(server).get('/api/cnpg/locations')).status).toBe(403);
      const res = await request(server)
        .post('/api/cnpg/locations')
        .send({ name: 'x', kubeconfig: 'y' });
      expect(res.status).toBe(403);
      expect(locations.create).not.toHaveBeenCalled();
    });
  });

  it('lists projects as summaries', async () => {
    const server = await start(fakeK8s());
    const res = await request(server).get('/api/cnpg/projects');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        name: 'demo',
        owner: 'team-demo',
        ready: true,
        deletionProtection: true,
        prometheus: true,
        grafana: true,
        grafanaUrl: 'http://grafana-demo.example.com',
      }),
    ]);
  });

  it('creates a project with the owner in spec and label', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .post('/api/cnpg/projects')
      .send({
        name: 'team-a',
        owner: 'team-a',
        description: 'A team',
        spec: { quota: { cpu: '4' } },
      });
    expect(res.status).toBe(201);
    expect(k8s.applyProject).toHaveBeenCalledWith({
      name: 'team-a',
      spec: { quota: { cpu: '4' }, owner: 'team-a', description: 'A team' },
      labels: { 'backstage.io/owner': 'team-a' },
      createOnly: true,
      dryRun: undefined,
    });
  });

  it('rejects project names the XRD would reject', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    for (const name of ['Bad_Name', 'a--b']) {
      const res = await request(server).post('/api/cnpg/projects').send({ name });
      expect(res.status).toBe(400);
    }
    expect(k8s.applyProject).not.toHaveBeenCalled();
  });

  it("won't delete a project that still has clusters", async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).delete('/api/cnpg/projects/demo');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('orders-db');
    expect(k8s.list).toHaveBeenCalledWith('demo');
    expect(k8s.deleteProject).not.toHaveBeenCalled();
  });

  it("won't delete a project that still has caches", async () => {
    const k8s = fakeK8s();
    k8s.list.mockResolvedValue([]);
    const valkey = fakeValkey([llmCache]);
    const server = await start(k8s, true, fakeLocations(), fakeBuckets(), fakeVolumes(), fakeAudit(), valkey);
    const res = await request(server).delete('/api/cnpg/projects/demo');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('llm-cache');
    expect(valkey.list).toHaveBeenCalledWith('demo');
    expect(k8s.deleteProject).not.toHaveBeenCalled();
  });

  it('deletes an empty project', async () => {
    const k8s = fakeK8s();
    k8s.list.mockResolvedValue([]);
    const server = await start(k8s);
    const res = await request(server).delete('/api/cnpg/projects/demo');
    expect(res.status).toBe(200);
    expect(k8s.deleteProject).toHaveBeenCalledWith('demo');
  });

  it('denies deleting a project without permission, and 404s a missing one', async () => {
    const k8s = fakeK8s();
    k8s.list.mockResolvedValue([]);
    expect((await request(await start(k8s, false)).delete('/api/cnpg/projects/demo')).status).toBe(403);
    expect((await request(await start(k8s)).delete('/api/cnpg/projects/nope')).status).toBe(404);
    expect(k8s.deleteProject).not.toHaveBeenCalled();
  });

  it('maps a missing project to 404', async () => {
    const server = await start(fakeK8s());
    const res = await request(server).get('/api/cnpg/projects/nope');
    expect(res.status).toBe(404);
  });

  it('creates a cluster with server-side apply and the owner label', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .post('/api/cnpg/clusters')
      .send({ name: 'new-db', namespace: 'demo', owner: 'team-a', spec: { instances: 3 } });
    expect(res.status).toBe(201);
    expect(k8s.apply).toHaveBeenCalledWith({
      name: 'new-db',
      namespace: 'demo',
      spec: { instances: 3 },
      labels: { 'backstage.io/owner': 'team-a' },
      createOnly: true,
    });
  });

  it('rejects invalid cluster names before touching Kubernetes', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .post('/api/cnpg/clusters')
      .send({ name: 'Bad_Name', namespace: 'demo', spec: {} });
    expect(res.status).toBe(400);
    expect(k8s.apply).not.toHaveBeenCalled();
  });

  it('maps a missing cluster to 404', async () => {
    const server = await start(fakeK8s());
    const res = await request(server).put('/api/cnpg/clusters/demo/nope').send({ spec: {} });
    expect(res.status).toBe(404);
  });

  it('patches only the changed fields of a cluster', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .patch('/api/cnpg/clusters/demo/orders-db')
      .send({ spec: { instances: 5, storage: { size: '50Gi' }, pooler: null }, dryRun: true });
    expect(res.status).toBe(200);
    expect(k8s.patch).toHaveBeenCalledWith({
      namespace: 'demo',
      name: 'orders-db',
      spec: { instances: 5, storage: { size: '50Gi' }, pooler: null },
      labels: undefined,
      dryRun: true,
    });
  });

  it('changes the owner label of a cluster', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    await request(server)
      .patch('/api/cnpg/clusters/demo/orders-db')
      .send({ spec: {}, owner: 'team-b' });
    expect(k8s.patch).toHaveBeenCalledWith(
      expect.objectContaining({ labels: { 'backstage.io/owner': 'team-b' } }),
    );
  });

  it('keeps the project owner label in step with spec.owner', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server)
      .patch('/api/cnpg/projects/demo')
      .send({ spec: { owner: '', quota: null } });
    expect(res.status).toBe(200);
    expect(k8s.patchProject).toHaveBeenCalledWith({
      name: 'demo',
      spec: { owner: null, quota: null },
      labels: { 'backstage.io/owner': null },
      dryRun: undefined,
    });
    const bad = await request(server)
      .patch('/api/cnpg/projects/demo')
      .send({ spec: { owner: 'not a group!' } });
    expect(bad.status).toBe(400);
  });

  describe('disaster recovery', () => {
    const geoDb: PostgresCluster = {
      ...ordersDb,
      spec: { ...ordersDb.spec, geoReplication: { enabled: true, primarySite: 'protected', promotion: 'Switchover' } },
      status: { ...ordersDb.status, primarySite: 'protected' },
    };

    it('switches over by patching only primarySite and promotion', async () => {
      const k8s = fakeK8s();
      k8s.get.mockResolvedValue(geoDb);
      const server = await start(k8s);
      const res = await request(server)
        .post('/api/cnpg/clusters/demo/orders-db/promote')
        .send({ site: 'recovery', mode: 'Switchover' });
      expect(res.status).toBe(200);
      expect(k8s.patch).toHaveBeenCalledWith({
        namespace: 'demo',
        name: 'orders-db',
        spec: { geoReplication: { primarySite: 'recovery', promotion: 'Switchover' } },
        dryRun: undefined,
      });
    });

    it('refuses moves that make no sense now with 409', async () => {
      const k8s = fakeK8s();
      const server = await start(k8s);
      // ordersDb has no replica cluster.
      const res = await request(server)
        .post('/api/cnpg/clusters/demo/orders-db/promote')
        .send({ site: 'recovery', mode: 'Failover' });
      expect(res.status).toBe(409);
      const bad = await request(server)
        .post('/api/cnpg/clusters/demo/orders-db/promote')
        .send({ site: 'elsewhere', mode: 'Switchover' });
      expect(bad.status).toBe(400);
      expect(k8s.patch).not.toHaveBeenCalled();
    });

    it('keeps edits from moving the primary', async () => {
      const k8s = fakeK8s();
      k8s.get.mockResolvedValue(geoDb);
      const server = await start(k8s);
      const moved = await request(server)
        .patch('/api/cnpg/clusters/demo/orders-db')
        .send({ spec: { geoReplication: { primarySite: 'recovery' } } });
      expect(moved.status).toBe(400);
      const drained = await request(server)
        .patch('/api/cnpg/clusters/demo/orders-db')
        .send({ spec: { geoReplication: { enabled: false, primarySite: 'protected' } } });
      expect(drained.status).toBe(200);
      expect(k8s.patch).toHaveBeenCalledTimes(1);
    });

    it('needs the switchover or failover permission', async () => {
      const k8s = fakeK8s();
      k8s.get.mockResolvedValue(geoDb);
      const server = await start(k8s, false);
      const res = await request(server)
        .post('/api/cnpg/clusters/demo/orders-db/promote')
        .send({ site: 'recovery', mode: 'Failover' });
      expect(res.status).toBe(403);
      expect(k8s.patch).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    const backedUp: PostgresCluster = {
      ...ordersDb,
      spec: {
        ...ordersDb.spec,
        storage: { size: '50Gi' },
        backup: { enabled: true },
        geoReplication: { enabled: true },
      },
      status: {
        ...ordersDb.status,
        backup: { serverName: 'orders-db', firstRecoverabilityPoint: '2026-10-01T02:00:00Z' },
      },
    };
    const withInventory: Project = {
      ...demoProject,
      status: {
        ...demoProject.status,
        backup: {
          ready: true,
          servers: [
            { serverName: 'old-db', cluster: 'old-db', active: false, postgresVersion: 16, database: 'app', owner: 'app',
              firstRecoverabilityPoint: '2026-09-01T02:00:00Z' },
          ],
        },
      },
    };

    it("creates a copy of a cluster from its backup folder, keeping the source's settings and owner", async () => {
      const k8s = fakeK8s();
      k8s.get.mockResolvedValue(backedUp);
      const server = await start(k8s);
      const res = await request(server)
        .post('/api/cnpg/projects/demo/restore')
        .send({ name: 'orders-copy', from: { cluster: 'orders-db' }, targetTime: '2026-10-07T12:00:00Z' });
      expect(res.status).toBe(201);
      expect(k8s.apply).toHaveBeenCalledWith({
        namespace: 'demo',
        name: 'orders-copy',
        spec: {
          postgresVersion: 17,
          instances: 3,
          pooler: { enabled: true },
          storage: { size: '50Gi' },
          backup: { enabled: true },
          restore: { source: { serverName: 'orders-db' }, targetTime: '2026-10-07T12:00:00Z' },
        },
        labels: { 'backstage.io/owner': 'team-orders' },
        createOnly: true,
        dryRun: undefined,
      });
    });

    it("restores a deleted cluster's folder from the Project's inventory", async () => {
      const k8s = fakeK8s();
      k8s.getProject.mockResolvedValue(withInventory);
      const server = await start(k8s);
      const res = await request(server)
        .post('/api/cnpg/projects/demo/restore')
        .send({ name: 'old-db', from: { serverName: 'old-db' }, storageSize: '20Gi' });
      expect(res.status).toBe(201);
      expect(k8s.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'old-db',
          spec: {
            backup: { enabled: true },
            postgresVersion: 16,
            database: { name: 'app', owner: 'app' },
            storage: { size: '20Gi' },
            restore: { source: { serverName: 'old-db' } },
          },
          labels: undefined,
        }),
      );
      const missing = await request(server)
        .post('/api/cnpg/projects/demo/restore')
        .send({ name: 'x', from: { serverName: 'nope' } });
      expect(missing.status).toBe(404);
    });

    it('refuses what the backups cannot give', async () => {
      const k8s = fakeK8s();
      const server = await start(k8s);
      // ordersDb has no backups.
      const noBackups = await request(server)
        .post('/api/cnpg/projects/demo/restore')
        .send({ name: 'orders-copy', from: { cluster: 'orders-db' } });
      expect(noBackups.status).toBe(409);
      k8s.get.mockResolvedValue(backedUp);
      const tooEarly = await request(server)
        .post('/api/cnpg/projects/demo/restore')
        .send({ name: 'orders-copy', from: { cluster: 'orders-db' }, targetTime: '2026-09-01T00:00:00Z' });
      expect(tooEarly.status).toBe(400);
      expect(tooEarly.body.error.message).toMatch(/before the oldest recoverable moment/);
      expect(k8s.apply).not.toHaveBeenCalled();
    });

    it('needs the restore permission, also through the plain create', async () => {
      const k8s = fakeK8s();
      k8s.get.mockResolvedValue(backedUp);
      const server = await start(k8s, false);
      const res = await request(server)
        .post('/api/cnpg/projects/demo/restore')
        .send({ name: 'orders-copy', from: { cluster: 'orders-db' } });
      expect(res.status).toBe(403);
      const created = await request(server)
        .post('/api/cnpg/clusters')
        .send({ name: 'orders-copy', namespace: 'demo', spec: { restore: { source: { serverName: 'orders-db' } } } });
      expect(created.status).toBe(403);
      expect(k8s.apply).not.toHaveBeenCalled();
    });
  });

  it('deletes a cluster', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s);
    const res = await request(server).delete('/api/cnpg/clusters/demo/orders-db');
    expect(res.status).toBe(202);
    expect(k8s.delete).toHaveBeenCalledWith('demo', 'orders-db');
  });

  it('enforces permissions', async () => {
    const k8s = fakeK8s();
    const server = await start(k8s, false);
    const res = await request(server).delete('/api/cnpg/clusters/demo/orders-db');
    expect(res.status).toBe(403);
    expect(k8s.delete).not.toHaveBeenCalled();
    const created = await request(server).post('/api/cnpg/projects').send({ name: 'team-a' });
    expect(created.status).toBe(403);
    expect(k8s.applyProject).not.toHaveBeenCalled();
    const patched = await request(server).patch('/api/cnpg/projects/demo').send({ spec: {} });
    expect(patched.status).toBe(403);
    expect(k8s.patchProject).not.toHaveBeenCalled();
  });
  describe('buckets', () => {
    it('lists the buckets on the account', async () => {
      const server = await start(fakeK8s());
      const res = await request(server).get('/api/cnpg/buckets');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: true, items: [orphan] });
    });

    it('says why the object store could not be read', async () => {
      const buckets = fakeBuckets(false);
      const server = await start(fakeK8s(), true, fakeLocations(), buckets);
      const res = await request(server).get('/api/cnpg/buckets');
      expect(res.body).toEqual({ configured: false, items: [], storeError: 'No object store configured' });
    });

    it('shows one bucket, 404 for an unknown one', async () => {
      const server = await start(fakeK8s());
      expect((await request(server).get(`/api/cnpg/buckets/${orphan.name}`)).body.summary).toEqual(orphan);
      expect((await request(server).get('/api/cnpg/buckets/nope-bucket')).status).toBe(404);
    });

    it('deletes a bucket', async () => {
      const buckets = fakeBuckets();
      const server = await start(fakeK8s(), true, fakeLocations(), buckets);
      const res = await request(server).delete(`/api/cnpg/buckets/${orphan.name}`);
      expect(res.status).toBe(200);
      expect(buckets.delete).toHaveBeenCalledWith(orphan.name);
    });

    it('rejects an invalid bucket name', async () => {
      const buckets = fakeBuckets();
      const server = await start(fakeK8s(), true, fakeLocations(), buckets);
      expect((await request(server).delete('/api/cnpg/buckets/UPPER_case')).status).toBe(400);
      expect(buckets.delete).not.toHaveBeenCalled();
    });

    it('needs the bucket permissions', async () => {
      const buckets = fakeBuckets();
      const server = await start(fakeK8s(), false, fakeLocations(), buckets);
      expect((await request(server).get('/api/cnpg/buckets')).status).toBe(403);
      expect((await request(server).delete(`/api/cnpg/buckets/${orphan.name}`)).status).toBe(403);
      expect(buckets.delete).not.toHaveBeenCalled();
    });
  });

  describe('audit', () => {
    it("returns a project's audit log", async () => {
      const audit = fakeAudit();
      const server = await start(fakeK8s(), true, fakeLocations(), fakeBuckets(), fakeVolumes(), audit);
      const res = await request(server).get('/api/cnpg/projects/demo/audit?tailLines=200');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ project: 'demo', items: [], clusters: [] });
      expect(audit.list).toHaveBeenCalledWith({ project: 'demo', tailLines: 200 });
      expect((await request(server).get('/api/cnpg/projects/Bad_Name/audit')).status).toBe(400);
      expect((await request(server).get('/api/cnpg/projects/demo/audit?tailLines=0')).status).toBe(400);
    });

    it('needs the audit permission', async () => {
      const audit = fakeAudit();
      const server = await start(fakeK8s(), false, fakeLocations(), fakeBuckets(), fakeVolumes(), audit);
      expect((await request(server).get('/api/cnpg/projects/demo/audit')).status).toBe(403);
      expect(audit.list).not.toHaveBeenCalled();
    });
  });

  describe('volumes', () => {
    it('lists the volumes, optionally of one project', async () => {
      const volumes = fakeVolumes();
      const server = await start(fakeK8s(), true, fakeLocations(), fakeBuckets(), volumes);
      const res = await request(server).get('/api/cnpg/volumes?project=demo');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [orphanVolume] });
      expect(volumes.list).toHaveBeenCalledWith({ project: 'demo' });
      expect((await request(server).get('/api/cnpg/volumes?project=Bad_Name')).status).toBe(400);
    });

    it('deletes an orphaned claim or released volume', async () => {
      const volumes = fakeVolumes();
      const server = await start(fakeK8s(), true, fakeLocations(), fakeBuckets(), volumes);
      expect((await request(server).delete('/api/cnpg/volumes/prod-ams/claims/demo/gone-db-1')).status).toBe(200);
      expect(volumes.deleteClaim).toHaveBeenCalledWith('prod-ams', 'demo', 'gone-db-1');
      expect((await request(server).delete('/api/cnpg/volumes/prod-ams/persistentvolumes/pv-3')).status).toBe(200);
      expect(volumes.deleteVolume).toHaveBeenCalledWith('prod-ams', 'pv-3');
    });

    it('needs the volume permissions', async () => {
      const volumes = fakeVolumes();
      const server = await start(fakeK8s(), false, fakeLocations(), fakeBuckets(), volumes);
      expect((await request(server).get('/api/cnpg/volumes')).status).toBe(403);
      expect((await request(server).delete('/api/cnpg/volumes/prod-ams/claims/demo/gone-db-1')).status).toBe(403);
      expect((await request(server).delete('/api/cnpg/volumes/prod-ams/persistentvolumes/pv-3')).status).toBe(403);
      expect(volumes.deleteClaim).not.toHaveBeenCalled();
      expect(volumes.deleteVolume).not.toHaveBeenCalled();
    });
  });

  describe('caches', () => {
    const startWith = (valkey: ReturnType<typeof fakeValkey>, allow = true) =>
      start(fakeK8s(), allow, fakeLocations(), fakeBuckets(), fakeVolumes(), fakeAudit(), valkey);

    it('lists caches as summaries with their project', async () => {
      const valkey = fakeValkey([llmCache]);
      const res = await request(await startWith(valkey)).get('/api/cnpg/caches?namespace=demo');
      expect(res.status).toBe(200);
      expect(valkey.list).toHaveBeenCalledWith('demo');
      expect(res.body.items).toEqual([
        expect.objectContaining({
          name: 'llm-cache',
          namespace: 'demo',
          mode: 'semantic',
          shards: 1,
          replicas: 0,
          ready: true,
          state: 'Ready',
          location: 'prod-ams',
          owner: 'team-ai',
          project: 'demo',
        }),
      ]);
    });

    it('reads details and the connection through the location', async () => {
      const valkey = fakeValkey([llmCache]);
      const server = await startWith(valkey);
      const details = await request(server).get('/api/cnpg/caches/demo/llm-cache');
      expect(details.status).toBe(200);
      expect(details.body.summary).toMatchObject({ name: 'llm-cache', project: 'demo' });
      const conn = await request(server).get('/api/cnpg/caches/demo/llm-cache/connection');
      expect(conn.status).toBe(200);
      expect(conn.headers['cache-control']).toBe('no-store');
      expect(conn.body.uri).toContain('valkey://default:');
      const kubeConfigFor = valkey.connection.mock.calls[0][2] as (l: string) => Promise<unknown>;
      expect(await kubeConfigFor('prod-ams')).toEqual({ location: 'prod-ams' });
    });

    it('creates a cache with its owner label, and refuses bad names', async () => {
      const valkey = fakeValkey();
      const server = await startWith(valkey);
      const res = await request(server)
        .post('/api/cnpg/caches')
        .send({ name: 'llm-cache', namespace: 'demo', owner: 'team-ai', spec: { mode: 'semantic' } });
      expect(res.status).toBe(201);
      expect(valkey.apply).toHaveBeenCalledWith({
        name: 'llm-cache',
        namespace: 'demo',
        spec: { mode: 'semantic' },
        labels: { 'backstage.io/owner': 'team-ai' },
        createOnly: true,
      });
      const bad = await request(server).post('/api/cnpg/caches').send({ name: 'Bad', namespace: 'demo', spec: {} });
      expect(bad.status).toBe(400);
    });

    it('patches and deletes a cache', async () => {
      const valkey = fakeValkey([llmCache]);
      const server = await startWith(valkey);
      const patched = await request(server)
        .patch('/api/cnpg/caches/demo/llm-cache')
        .send({ spec: { shards: 2 }, dryRun: true });
      expect(patched.status).toBe(200);
      expect(valkey.patch).toHaveBeenCalledWith({
        namespace: 'demo',
        name: 'llm-cache',
        spec: { shards: 2 },
        labels: undefined,
        dryRun: true,
      });
      expect((await request(server).delete('/api/cnpg/caches/demo/llm-cache')).status).toBe(202);
      expect(valkey.delete).toHaveBeenCalledWith('demo', 'llm-cache');
    });

    it('needs the cache permissions', async () => {
      const valkey = fakeValkey([llmCache]);
      const server = await startWith(valkey, false);
      expect((await request(server).get('/api/cnpg/caches')).status).toBe(403);
      expect((await request(server).get('/api/cnpg/caches/demo/llm-cache/connection')).status).toBe(403);
      expect((await request(server).post('/api/cnpg/caches').send({ name: 'x', namespace: 'demo', spec: {} })).status).toBe(403);
      expect((await request(server).delete('/api/cnpg/caches/demo/llm-cache')).status).toBe(403);
      expect(valkey.connection).not.toHaveBeenCalled();
      expect(valkey.apply).not.toHaveBeenCalled();
      expect(valkey.delete).not.toHaveBeenCalled();
    });
  });
});
