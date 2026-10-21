import { mockServices } from '@backstage/backend-test-utils';
import { ConflictError, InputError } from '@backstage/errors';
import { ApiException, CoreV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import { imageVolumeCheck, LocationService } from './LocationService';

// Nothing listens there: health probes fail fast instead of reaching out.
const KUBECONFIG = `
apiVersion: v1
kind: Config
current-context: prod
contexts:
  - name: prod
    context: { cluster: prod, user: admin }
clusters:
  - name: prod
    cluster: { server: 'https://127.0.0.1:9' }
users:
  - name: admin
    user: { token: abc }
`;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const apiError = (code: number, message: string) =>
  new ApiException(code, message, JSON.stringify({ message }), {});

const LOCATION = {
  apiVersion: 'platform.cndev.nl/v1alpha1',
  kind: 'Location',
  metadata: { name: 'prod-ams', creationTimestamp: '2026-10-01T00:00:00Z' },
  spec: {
    environment: 'production',
    region: 'ams',
    schedulable: true,
    credentials: { secretRef: { namespace: 'cnpg-locations', name: 'prod-ams', key: 'kubeconfig' } },
    crossplane: { compositionRef: { name: 'location' } },
  },
  status: {
    ready: false,
    connected: true,
    providerConfig: 'prod-ams',
    message: 'Connected; the Prometheus Operator CRDs not installed',
    operators: { cloudnativepg: true, prometheusOperator: false },
  },
};
const SECRET = {
  metadata: {
    name: 'prod-ams',
    namespace: 'cnpg-locations',
    labels: { 'platform.cndev.nl/location': 'true' },
  },
  data: { kubeconfig: b64(KUBECONFIG) },
};

function setup() {
  const core = {
    listNamespacedSecret: jest.fn(async () => ({ items: [SECRET] })),
    readNamespacedSecret: jest.fn(async () => SECRET),
    createNamespacedSecret: jest.fn(async ({ body }: any) => body),
    replaceNamespacedSecret: jest.fn(async ({ body }: any) => body),
    deleteNamespacedSecret: jest.fn(async () => ({})),
    createNamespace: jest.fn(async () => ({})),
  };
  const custom = {
    listClusterCustomObject: jest.fn(async () => ({ items: [LOCATION] })),
    getClusterCustomObject: jest.fn(async ({ name }: any) => {
      if (name === 'prod-ams') return LOCATION;
      throw apiError(404, 'not found');
    }),
    createClusterCustomObject: jest.fn(async ({ body }: any) => body),
    replaceClusterCustomObject: jest.fn(async ({ body }: any) => body),
    deleteClusterCustomObject: jest.fn(async () => ({})),
  };
  const kubeConfig = new KubeConfig();
  jest.spyOn(kubeConfig, 'makeApiClient').mockImplementation(((api: unknown) =>
    api === CoreV1Api ? core : custom) as any);
  const service = new LocationService({
    kubeConfig,
    namespace: 'cnpg-locations',
    logger: mockServices.logger.mock(),
  });
  // The cast keeps the fakes' jest.Mock typing for assertions.
  return { service, core, custom: custom as typeof custom & CustomObjectsApi };
}

describe('LocationService', () => {
  it('lists Locations with what Crossplane reports and the kubeconfig connection', async () => {
    const { service, core } = setup();
    const [l] = await service.list();
    expect(l).toMatchObject({
      name: 'prod-ams',
      spec: { environment: 'production', region: 'ams', schedulable: true },
      providerConfig: true,
      status: { connected: true, operators: { cloudnativepg: true, prometheusOperator: false } },
      connection: { server: 'https://127.0.0.1:9', auth: 'token' },
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    expect(l.spec).not.toHaveProperty('credentials');
    expect(l.spec).not.toHaveProperty('crossplane');
    // The Secret came from the list, not one read per location.
    expect(core.readNamespacedSecret).not.toHaveBeenCalled();
  });

  it('lists nothing when the Location API is not installed', async () => {
    const { service, custom } = setup();
    custom.listClusterCustomObject.mockRejectedValueOnce(apiError(404, 'the server could not find the requested resource'));
    await expect(service.list()).resolves.toEqual([]);
  });

  it('creates the kubeconfig Secret, then a Location referencing it', async () => {
    const { service, core, custom } = setup();
    await service.create({
      name: 'dr-rtm',
      kubeconfig: KUBECONFIG,
      spec: { environment: 'production', region: '', owner: 'team-platform' },
    });
    expect(core.createNamespacedSecret.mock.calls[0][0]).toMatchObject({
      namespace: 'cnpg-locations',
      body: {
        metadata: { name: 'dr-rtm', labels: { 'platform.cndev.nl/location': 'true' } },
        stringData: { kubeconfig: expect.stringContaining('127.0.0.1:9') },
      },
    });
    const body = (custom.createClusterCustomObject.mock.calls[0][0] as any).body;
    expect(body).toEqual({
      apiVersion: 'platform.cndev.nl/v1alpha1',
      kind: 'Location',
      metadata: {
        name: 'dr-rtm',
        labels: { 'app.kubernetes.io/managed-by': 'backstage', 'backstage.io/owner': 'team-platform' },
      },
      // Empty strings dropped: the XRD's patterns would reject them.
      spec: {
        environment: 'production',
        owner: 'team-platform',
        credentials: { secretRef: { namespace: 'cnpg-locations', name: 'dr-rtm', key: 'kubeconfig' } },
      },
    });
    expect(core.createNamespacedSecret.mock.invocationCallOrder[0]).toBeLessThan(
      custom.createClusterCustomObject.mock.invocationCallOrder[0],
    );
  });

  it('refuses a name that is already a Location', async () => {
    const { service, core } = setup();
    await expect(
      service.create({ name: 'prod-ams', kubeconfig: KUBECONFIG, spec: {} }),
    ).rejects.toThrow(ConflictError);
    expect(core.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('removes the Secret again when the API server rejects the Location', async () => {
    const { service, core, custom } = setup();
    custom.createClusterCustomObject.mockRejectedValueOnce(apiError(422, 'spec.region: Too long'));
    await expect(
      service.create({ name: 'dr-rtm', kubeconfig: KUBECONFIG, spec: {} }),
    ).rejects.toThrow(InputError);
    expect(core.deleteNamespacedSecret).toHaveBeenCalledWith({ namespace: 'cnpg-locations', name: 'dr-rtm' });
  });

  it('replaces the settings but keeps the credentials and Crossplane fields', async () => {
    const { service, core, custom } = setup();
    await service.update('prod-ams', { spec: { schedulable: false } });
    const body = (custom.replaceClusterCustomObject.mock.calls[0][0] as any).body;
    expect(body.spec).toEqual({
      schedulable: false,
      credentials: LOCATION.spec.credentials,
      crossplane: LOCATION.spec.crossplane,
    });
    expect(core.replaceNamespacedSecret).not.toHaveBeenCalled();
  });

  it('writes a new kubeconfig to the referenced Secret', async () => {
    const { service, core } = setup();
    core.createNamespacedSecret.mockRejectedValueOnce(apiError(409, 'already exists'));
    await service.update('prod-ams', { spec: {}, kubeconfig: KUBECONFIG });
    expect(core.replaceNamespacedSecret.mock.calls[0][0]).toMatchObject({
      namespace: 'cnpg-locations',
      name: 'prod-ams',
      body: { stringData: { kubeconfig: expect.stringContaining('127.0.0.1:9') } },
    });
  });

  it('deletes the Location, then its Secret', async () => {
    const { service, core, custom } = setup();
    await service.delete('prod-ams');
    expect(custom.deleteClusterCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'platform.cndev.nl', plural: 'locations', name: 'prod-ams' }),
    );
    expect(core.deleteNamespacedSecret).toHaveBeenCalledWith({ namespace: 'cnpg-locations', name: 'prod-ams' });
  });

  it('keeps the Secret when the API server refuses to delete a Location in use', async () => {
    const { service, core, custom } = setup();
    custom.deleteClusterCustomObject.mockRejectedValueOnce(
      apiError(409, 'This resource is in-use by 1 usage(s), including the ClusterUsage "project-team-ledger-location-prod-ams"'),
    );
    await expect(service.delete('prod-ams')).rejects.toThrow(/in-use/);
    expect(core.deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it('reads a location kubeconfig through the Secret its Location references', async () => {
    const { service, core } = setup();
    const kc = await service.kubeConfig('prod-ams');
    expect(kc.getCurrentCluster()?.server).toBe('https://127.0.0.1:9');
    expect(core.readNamespacedSecret).toHaveBeenCalledWith({ namespace: 'cnpg-locations', name: 'prod-ams' });
  });
});

describe('imageVolumeCheck', () => {
  const node = (name: string, runtime: string) => ({
    metadata: { name },
    status: { nodeInfo: { containerRuntimeVersion: runtime } },
  }) as any;
  const accepted = { status: 'fulfilled', value: { spec: { volumes: [{ name: 'ext', image: { reference: 'busybox' } }] } } } as const;

  it('passes when the API server accepts image volumes and every runtime supports them', () => {
    const check = imageVolumeCheck(accepted as any, [node('a', 'containerd://2.1.9'), node('b', 'cri-o://1.31.2')]);
    expect(check.status).toBe('ok');
  });

  it('warns when the feature gate is off', () => {
    const check = imageVolumeCheck({ status: 'rejected', reason: apiError(422, 'must specify a volume type') }, []);
    expect(check).toMatchObject({ status: 'warning', message: expect.stringContaining('feature gate is off') });
  });

  it('warns when the API server dropped the image volume', () => {
    const check = imageVolumeCheck({ status: 'fulfilled', value: { spec: { containers: [], volumes: [{ name: 'ext' }] } } }, []);
    expect(check).toMatchObject({ status: 'warning', message: expect.stringContaining('dropped') });
  });

  it('names the nodes with a runtime too old for image volumes', () => {
    const check = imageVolumeCheck(accepted as any, [node('a', 'containerd://2.1.0'), node('b', 'containerd://1.7.27')]);
    expect(check).toMatchObject({ status: 'warning', message: expect.stringContaining('b (containerd://1.7.27)') });
    expect(check.message).not.toContain('a (');
  });

  it('cannot tell when the dry run is refused', () => {
    const check = imageVolumeCheck({ status: 'rejected', reason: apiError(403, 'pods is forbidden') }, []);
    expect(check).toMatchObject({ status: 'warning', message: expect.stringContaining('could not check') });
  });
});
