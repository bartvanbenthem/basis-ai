import {
  coreServices,
  createServiceFactory,
  createServiceRef,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { ConflictError, InputError, NotFoundError } from '@backstage/errors';
import {
  ApiException,
  ApisApi,
  CoreV1Api,
  CustomObjectsApi,
  Health,
  KubeConfig,
  V1Node,
  V1Pod,
  V1Secret,
  VersionApi,
} from '@kubernetes/client-node';
import {
  LOCAL_LOCATION,
  LOCATION_LABEL,
  LocationCheck,
  LocationConnection,
  LocationHealth,
  LocationSpec,
  LocationStatus,
  LocationSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { apiMessage, cnpgKubernetesServiceRef, kubeCall } from './CnpgKubernetesService';
import { parseKubeconfig } from './kubeconfig';

const KUBECONFIG_KEY = 'kubeconfig';
const OWNER_LABEL = 'backstage.io/owner';
/** The Location API (api/apis/location), cluster-scoped. */
const LOCATION_API = { group: 'platform.cndev.nl', version: 'v1alpha1', plural: 'locations' };
const API_MISSING =
  'The Location API (locations.platform.cndev.nl) is not installed; run api/install/install.sh';

interface LocationResource {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    creationTimestamp?: string | Date;
    resourceVersion?: string;
  };
  spec: LocationSpec & {
    credentials: { secretRef: { namespace: string; name: string; key?: string } };
    /** Crossplane's own fields (compositionRef, resourceRefs, ...). */
    crossplane?: unknown;
  };
  status?: LocationStatus & { providerConfig?: string };
}
/** Per call; an unreachable location answers the list page within a few seconds. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long a health result is reused before the next request probes again. */
const HEALTH_TTL_MS = 30_000;

/** Also for the router's calls into locations, which may not answer. */
export function withTimeout<T>(promise: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One line for an error from a location's API server, without stack noise. */
function describe(e: unknown): string {
  if (e instanceof ApiException) {
    if (e.code === 401) return 'credentials rejected (401 Unauthorized)';
    if (e.code === 403) return `not allowed (403): ${apiMessage(e)}`;
    return `HTTP ${e.code}: ${apiMessage(e)}`;
  }
  const err = e as Error & { cause?: Error; code?: string };
  return (err.cause?.message ?? err.message ?? String(e)).split('\n')[0];
}

/**
 * A Pod with an image volume, created with dryRun=All: an API server whose
 * ImageVolume feature gate is off drops the volume source and rejects it
 * (422). CNPG mounts extension images (PostgreSQL 18+) this way.
 */
const IMAGE_VOLUME_POD: V1Pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { generateName: 'basis-preflight-' },
  spec: {
    // Pod Security "restricted" compliant, so an enforcing namespace doesn't refuse it.
    securityContext: { runAsNonRoot: true, runAsUser: 65534, seccompProfile: { type: 'RuntimeDefault' } },
    containers: [
      {
        name: 'probe',
        image: 'busybox',
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        volumeMounts: [{ name: 'ext', mountPath: '/ext' }],
      },
    ],
    volumes: [{ name: 'ext', image: { reference: 'busybox', pullPolicy: 'IfNotPresent' } }],
  },
};

/** Minimum container runtime versions that mount image volumes. */
const IMAGE_VOLUME_RUNTIMES: Record<string, number[]> = {
  containerd: [2, 1, 0],
  'cri-o': [1, 31, 0],
};

function versionAtLeast(version: string, min: number[]): boolean {
  const parts = version.replace(/^v/, '').split(/[.+-]/).map(n => parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    const p = Number.isNaN(parts[i]) || parts[i] === undefined ? 0 : parts[i];
    if (p !== min[i]) return p > min[i];
  }
  return true;
}

/**
 * Whether the location can mount extension images (CNPG image volume
 * extensions): the API server accepts an image volume (dry run), and every
 * node runs a container runtime that supports them. A warning, not an error:
 * only clusters with extension images need it.
 */
export function imageVolumeCheck(api: PromiseSettledResult<V1Pod>, nodes: V1Node[] | undefined): LocationCheck {
  const name = 'Image volumes';
  if (api.status === 'rejected') {
    const e = api.reason;
    if (e instanceof ApiException && e.code === 422) {
      return {
        name,
        status: 'warning',
        message: 'ImageVolume feature gate is off on the API server; extension images (PostgreSQL 18+) cannot be mounted',
      };
    }
    return { name, status: 'warning', message: `could not check: ${describe(e)}` };
  }
  if (!api.value.spec?.volumes?.some(v => v.image)) {
    return {
      name,
      status: 'warning',
      message: 'the API server dropped the image volume (ImageVolume feature gate off); extension images cannot be mounted',
    };
  }
  if (!nodes) {
    return { name, status: 'warning', message: 'API server supports image volumes; node runtimes not checked' };
  }
  const unsupported: string[] = [];
  const unknown: string[] = [];
  for (const node of nodes) {
    const runtime = node.status?.nodeInfo?.containerRuntimeVersion ?? '';
    const [kind, version = ''] = runtime.split('://');
    const min = IMAGE_VOLUME_RUNTIMES[kind];
    if (!min) unknown.push(`${node.metadata?.name} (${runtime || 'unknown runtime'})`);
    else if (!versionAtLeast(version, min)) unsupported.push(`${node.metadata?.name} (${runtime})`);
  }
  if (unsupported.length) {
    return {
      name,
      status: 'warning',
      message: `container runtime too old for image volumes (containerd >= 2.1, CRI-O >= 1.31): ${unsupported.join(', ')}`,
    };
  }
  if (unknown.length) {
    return { name, status: 'warning', message: `API server supports image volumes; runtime not recognised on ${unknown.join(', ')}` };
  }
  const runtimes = [...new Set(nodes.map(n => n.status?.nodeInfo?.containerRuntimeVersion))].join(', ');
  return { name, status: 'ok', message: `supported: API server accepts image volumes, nodes run ${runtimes}` };
}

/**
 * Probes a location's API server: reachable and authenticated (/version),
 * ready (/readyz), nodes Ready, whether CloudNativePG (and the optional Valkey
 * operator) is installed and whether it can mount extension images (image volumes).
 * Unreachable when /version fails; degraded when any check is an error.
 */
export async function probe(kubeconfig: string): Promise<LocationHealth> {
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  const checkedAt = new Date().toISOString();
  const checks: LocationCheck[] = [];

  const started = Date.now();
  let version;
  try {
    version = await withTimeout(kc.makeApiClient(VersionApi).getCode());
  } catch (e) {
    return {
      status: 'unreachable',
      checkedAt,
      checks: [{ name: 'API server', status: 'error', message: describe(e) }],
    };
  }
  const latencyMs = Date.now() - started;
  checks.push({
    name: 'API server',
    status: 'ok',
    message: `Kubernetes ${version.gitVersion} answered in ${latencyMs} ms`,
  });

  const core = kc.makeApiClient(CoreV1Api);
  const [ready, nodes, groups, imageVolume] = await Promise.allSettled([
    new Health(kc).readyz({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) } as any),
    withTimeout(core.listNode()),
    withTimeout(kc.makeApiClient(ApisApi).getAPIVersions()),
    withTimeout(core.createNamespacedPod({ namespace: 'default', body: IMAGE_VOLUME_POD, dryRun: 'All' })),
  ]);

  if (ready.status === 'fulfilled') {
    checks.push(
      ready.value
        ? { name: 'Readiness', status: 'ok', message: '/readyz reports ready' }
        : { name: 'Readiness', status: 'error', message: '/readyz reports not ready' },
    );
  } else {
    checks.push({ name: 'Readiness', status: 'warning', message: describe(ready.reason) });
  }

  let nodeCount: LocationHealth['nodes'];
  if (nodes.status === 'fulfilled') {
    const total = nodes.value.items.length;
    const readyNodes = nodes.value.items.filter(n =>
      n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True'),
    ).length;
    nodeCount = { ready: readyNodes, total };
    let status: LocationCheck['status'] = 'ok';
    if (readyNodes < total) status = 'warning';
    if (readyNodes === 0) status = 'error';
    checks.push({ name: 'Nodes', status, message: `${readyNodes} of ${total} nodes Ready` });
  } else {
    checks.push({
      name: 'Nodes',
      status: 'warning',
      message: `could not list nodes: ${describe(nodes.reason)}`,
    });
  }

  if (groups.status === 'fulfilled') {
    const cnpg = groups.value.groups.some(g => g.name === 'postgresql.cnpg.io');
    checks.push(
      cnpg
        ? { name: 'CloudNativePG', status: 'ok', message: 'operator API (postgresql.cnpg.io) installed' }
        : { name: 'CloudNativePG', status: 'warning', message: 'operator not installed' },
    );
  } else {
    checks.push({ name: 'CloudNativePG', status: 'warning', message: describe(groups.reason) });
  }
  if (groups.status === 'fulfilled') {
    // Optional: only ValkeyCaches need it, so its absence is no warning.
    const valkey = groups.value.groups.some(g => g.name === 'valkey.io');
    checks.push(
      valkey
        ? { name: 'Valkey operator', status: 'ok', message: 'operator API (valkey.io) installed' }
        : { name: 'Valkey operator', status: 'ok', message: 'not installed; only needed for Valkey caches (deps/README.md)' },
    );
  }

  checks.push(imageVolumeCheck(imageVolume, nodes.status === 'fulfilled' ? nodes.value.items : undefined));

  return {
    status: checks.some(c => c.status === 'error') ? 'degraded' : 'healthy',
    checkedAt,
    latencyMs,
    kubernetesVersion: version.gitVersion,
    nodes: nodeCount,
    checks,
  };
}

/**
 * Locations (Kubernetes clusters the platform can use): a Location object
 * (api/apis/location) holding the settings, and the kubeconfig
 * as a Secret in one namespace of the platform cluster, which the Location
 * references. Crossplane composes the rest (the ClusterProviderConfig, the
 * Prometheus ClusterRole in the location) and reports in the Location's
 * status whether it got through. Health is probed from this backend and
 * cached briefly, so list pages don't hammer every API server.
 */
export class LocationService {
  readonly #core: CoreV1Api;
  readonly #custom: CustomObjectsApi;
  readonly #namespace: string;
  readonly #logger: LoggerService;
  readonly #health = new Map<string, { at: number; result: Promise<LocationHealth> }>();

  constructor(options: { kubeConfig: KubeConfig; namespace: string; logger: LoggerService }) {
    this.#core = options.kubeConfig.makeApiClient(CoreV1Api);
    this.#custom = options.kubeConfig.makeApiClient(CustomObjectsApi);
    this.#namespace = options.namespace;
    this.#logger = options.logger;
  }

  async list(): Promise<LocationSummary[]> {
    let res;
    try {
      res = await kubeCall(() => this.#custom.listClusterCustomObject(LOCATION_API));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      this.#logger.warn(`${API_MISSING}; no locations to list`);
      return [];
    }
    const locations = (res.items ?? []) as LocationResource[];
    const secrets = await this.#secrets();
    const items = await Promise.all(
      locations.map(async l => this.#summarize(l, await this.#kubeconfigOf(l, secrets), false)),
    );
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string, options: { refresh?: boolean } = {}): Promise<LocationSummary> {
    const location = await this.#location(name);
    return this.#summarize(location, await this.#kubeconfigOf(location), options.refresh ?? false);
  }

  /** Credentials for a location's API server, for reading what runs there (pods, events, logs). */
  async kubeConfig(name: string): Promise<KubeConfig> {
    const kubeconfig = await this.#kubeconfigOf(await this.#location(name));
    if (kubeconfig instanceof Error) throw kubeconfig;
    const kc = new KubeConfig();
    kc.loadFromString(kubeconfig);
    return kc;
  }

  /** Validates and probes a location without storing it ("Test connection"). */
  async test(options: { kubeconfig: string; context?: string }): Promise<LocationHealth> {
    return probe(parseKubeconfig(options.kubeconfig, options.context).kubeconfig);
  }

  async create(options: {
    name: string;
    kubeconfig: string;
    context?: string;
    spec: LocationSpec;
  }): Promise<LocationSummary> {
    const { name, spec } = options;
    if (name === LOCAL_LOCATION) {
      throw new InputError(`"${LOCAL_LOCATION}" is reserved; pick another name`);
    }
    const { kubeconfig } = parseKubeconfig(options.kubeconfig, options.context);
    const exists = await this.#location(name).then(
      () => true,
      e => {
        if (e instanceof NotFoundError) return false;
        throw e;
      },
    );
    if (exists) throw new ConflictError(`Location ${name} already exists`);

    // Secret first, so the ClusterProviderConfig never points at nothing.
    const secretRef = { namespace: this.#namespace, name, key: KUBECONFIG_KEY };
    await this.#writeSecret(name, kubeconfig);
    const body: LocationResource = {
      apiVersion: `${LOCATION_API.group}/${LOCATION_API.version}`,
      kind: 'Location',
      metadata: { name, labels: this.#labels(spec) },
      spec: { ...clean(spec), credentials: { secretRef } },
    };
    let created: LocationResource;
    try {
      created = (await kubeCall(() =>
        this.#custom.createClusterCustomObject({ ...LOCATION_API, body }),
      )) as LocationResource;
    } catch (e) {
      await kubeCall(() =>
        this.#core.deleteNamespacedSecret({ namespace: this.#namespace, name }),
      ).catch(() => undefined);
      if (e instanceof NotFoundError) throw new Error(API_MISSING);
      throw e;
    }
    this.#logger.info(`Added location ${name}`);
    this.#health.delete(name);
    return this.#summarize(created, kubeconfig, false);
  }

  /** Replaces the settings and, when given, the kubeconfig. */
  async update(
    name: string,
    options: { spec: LocationSpec; kubeconfig?: string; context?: string },
  ): Promise<LocationSummary> {
    const location = await this.#location(name);
    let kubeconfig: string | Error | undefined;
    if (options.kubeconfig) {
      kubeconfig = parseKubeconfig(options.kubeconfig, options.context).kubeconfig;
      const ref = location.spec.credentials.secretRef;
      if (ref.namespace !== this.#namespace) {
        throw new InputError(
          `Location ${name} reads its kubeconfig from ${ref.namespace}/${ref.name}, which the portal doesn't manage; update that Secret instead`,
        );
      }
      await this.#writeSecret(ref.name, kubeconfig, ref.key);
    }
    const labels = { ...location.metadata.labels, ...this.#labels(options.spec) };
    if (!options.spec.owner) delete labels[OWNER_LABEL];
    const body: LocationResource = {
      ...location,
      metadata: { ...location.metadata, labels },
      // Credentials and Crossplane's own fields (composition, resource refs) stay.
      spec: {
        ...clean(options.spec),
        credentials: location.spec.credentials,
        ...(location.spec.crossplane ? { crossplane: location.spec.crossplane } : {}),
      },
    };
    const updated = (await kubeCall(() =>
      this.#custom.replaceClusterCustomObject({ ...LOCATION_API, name, body }),
    )) as LocationResource;
    this.#logger.info(
      `Updated location ${name}${options.kubeconfig ? ' (new kubeconfig)' : ''}`,
    );
    this.#health.delete(name);
    return this.#summarize(updated, kubeconfig ?? (await this.#kubeconfigOf(updated)), false);
  }

  /**
   * Deletes the Location, then its Secret (when the portal manages it). The
   * API server refuses the first while a Project lists the location (the
   * Project composition's ClusterUsage); callers check first for a clearer
   * message.
   */
  async delete(name: string): Promise<void> {
    const location = await this.#location(name);
    await kubeCall(
      () => this.#custom.deleteClusterCustomObject({ ...LOCATION_API, name }),
      `Location ${name}`,
    );
    const ref = location.spec.credentials.secretRef;
    if (ref.namespace === this.#namespace) {
      try {
        const secret = await kubeCall(() =>
          this.#core.readNamespacedSecret({ namespace: ref.namespace, name: ref.name }),
        );
        if (secret.metadata?.labels?.[LOCATION_LABEL] === 'true') {
          await kubeCall(() =>
            this.#core.deleteNamespacedSecret({ namespace: ref.namespace, name: ref.name }),
          );
        }
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
    this.#health.delete(name);
    this.#logger.info(`Removed location ${name}`);
  }

  /** Creates or replaces a kubeconfig Secret in the locations namespace. */
  async #writeSecret(name: string, kubeconfig: string, key = KUBECONFIG_KEY): Promise<void> {
    const body: V1Secret = {
      metadata: {
        name,
        namespace: this.#namespace,
        labels: { [LOCATION_LABEL]: 'true', 'app.kubernetes.io/managed-by': 'backstage' },
      },
      type: 'Opaque',
      stringData: { [key]: kubeconfig },
    };
    const create = () =>
      kubeCall(() => this.#core.createNamespacedSecret({ namespace: this.#namespace, body }));
    try {
      await create();
    } catch (e) {
      if (e instanceof ConflictError) {
        // Left over from an earlier location of that name, or a new kubeconfig.
        await kubeCall(() =>
          this.#core.replaceNamespacedSecret({ namespace: this.#namespace, name, body }),
        );
        return;
      }
      if (!(e instanceof NotFoundError)) throw e;
      // First location: the namespace isn't there yet (in-cluster, deploy/ creates it).
      await kubeCall(() =>
        this.#core.createNamespace({ body: { metadata: { name: this.#namespace } } }),
      );
      await create();
    }
  }

  /** The labelled Secrets of the locations namespace, by name. */
  async #secrets(): Promise<Map<string, V1Secret>> {
    const res = await kubeCall(() =>
      this.#core.listNamespacedSecret({
        namespace: this.#namespace,
        labelSelector: `${LOCATION_LABEL}=true`,
      }),
    );
    return new Map(res.items.map(s => [s.metadata?.name ?? '', s]));
  }

  /**
   * The kubeconfig a Location references, or why it can't be read (missing
   * Secret, or one outside what this backend may read).
   */
  async #kubeconfigOf(
    location: LocationResource,
    secrets?: Map<string, V1Secret>,
  ): Promise<string | Error> {
    const ref = location.spec?.credentials?.secretRef;
    if (!ref) return new Error('the Location has no spec.credentials.secretRef');
    let secret = ref.namespace === this.#namespace ? secrets?.get(ref.name) : undefined;
    if (!secret) {
      try {
        secret = await kubeCall(
          () => this.#core.readNamespacedSecret({ namespace: ref.namespace, name: ref.name }),
          `Secret ${ref.namespace}/${ref.name}`,
        );
      } catch (e) {
        return e as Error;
      }
    }
    const data = secret.data?.[ref.key ?? KUBECONFIG_KEY];
    if (!data) return new Error(`Secret ${ref.namespace}/${ref.name} has no key ${ref.key ?? KUBECONFIG_KEY}`);
    return Buffer.from(data, 'base64').toString();
  }

  async #location(name: string): Promise<LocationResource> {
    if (name === LOCAL_LOCATION) throw new NotFoundError(`Location ${name} not found`);
    return (await kubeCall(
      () => this.#custom.getClusterCustomObject({ ...LOCATION_API, name }),
      `Location ${name}`,
    )) as LocationResource;
  }

  #labels(spec: LocationSpec): Record<string, string> {
    return {
      'app.kubernetes.io/managed-by': 'backstage',
      ...(spec.owner ? { [OWNER_LABEL]: spec.owner } : {}),
    };
  }

  async #summarize(
    location: LocationResource,
    kubeconfig: string | Error,
    refresh: boolean,
  ): Promise<LocationSummary> {
    const name = location.metadata.name;
    const { credentials: _credentials, crossplane: _crossplane, ...spec } = location.spec ?? {};
    const status = location.status ?? {};

    let connection: LocationConnection;
    let health: Promise<LocationHealth>;
    try {
      if (kubeconfig instanceof Error) throw kubeconfig;
      connection = parseKubeconfig(kubeconfig).connection;
      health = this.#probeCached(name, kubeconfig, refresh);
    } catch (e) {
      // No readable kubeconfig, or the Secret was edited into something we won't load.
      connection = { server: '-', context: '-', auth: '-', insecureSkipTlsVerify: false };
      health = Promise.resolve({
        status: 'unreachable',
        checkedAt: new Date().toISOString(),
        checks: [{ name: 'kubeconfig', status: 'error', message: (e as Error).message }],
      });
    }

    return {
      name,
      spec,
      connection,
      providerConfig: Boolean(status.providerConfig),
      status: {
        ready: status.ready,
        message: status.message,
        connected: status.connected,
        operators: status.operators,
      },
      owner: spec.owner,
      createdAt: location.metadata.creationTimestamp
        ? new Date(location.metadata.creationTimestamp).toISOString()
        : undefined,
      health: await health,
    };
  }

  /** Cached probe; concurrent requests share one in-flight probe. */
  #probeCached(name: string, kubeconfig: string, refresh: boolean): Promise<LocationHealth> {
    const cached = this.#health.get(name);
    if (!refresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.result;
    const result = probe(kubeconfig).catch(
      (e): LocationHealth => ({
        status: 'unreachable',
        checkedAt: new Date().toISOString(),
        checks: [{ name: 'API server', status: 'error', message: describe(e) }],
      }),
    );
    this.#health.set(name, { at: Date.now(), result });
    return result;
  }
}

/** Drops empty strings, which the XRD's enums and patterns would reject. */
function clean(spec: LocationSpec): LocationSpec {
  return Object.fromEntries(
    Object.entries(spec).filter(([, v]) => v !== undefined && v !== ''),
  ) as LocationSpec;
}

export const locationServiceRef = createServiceRef<LocationService>({
  id: 'cnpg.locations',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        k8s: cnpgKubernetesServiceRef,
      },
      factory: ({ config, logger, k8s }) =>
        new LocationService({
          kubeConfig: k8s.kubeConfig,
          namespace: config.getOptionalString('cnpg.locations.namespace') ?? 'cnpg-locations',
          logger,
        }),
    }),
});
