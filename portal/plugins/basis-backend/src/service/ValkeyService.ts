import {
  coreServices,
  createServiceFactory,
  createServiceRef,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError } from '@backstage/errors';
import {
  CoreV1Api,
  CustomObjectsApi,
  KubernetesObject,
  KubernetesObjectApi,
  PatchStrategy,
} from '@kubernetes/client-node';
import {
  CACHE_GROUP,
  CACHE_KIND,
  CACHE_PLURAL,
  CACHE_VERSION,
  CacheConnection,
  cacheLabelSelector,
  ClusterEvent,
  InstancePod,
  summarizeCache,
  ValkeyCache,
  ValkeyCacheDetails,
} from '@internal/backstage-plugin-cnpg-common';
import { cnpgKubernetesServiceRef, kubeCall, LocationKubeConfig } from './CnpgKubernetesService';

const FIELD_MANAGER = 'backstage-cnpg';
const API = { group: CACHE_GROUP, version: CACHE_VERSION, plural: CACHE_PLURAL };

/**
 * ValkeyCaches (cache.cndev.nl) on the control plane, and their pods, events
 * and password copy in the location they run in. Like PostgresClusters,
 * every write goes through the XR, so the API server validates it against
 * the XRD and the admission policy.
 */
export class ValkeyService {
  readonly #custom: CustomObjectsApi;
  readonly #objects: KubernetesObjectApi;
  readonly #logger: LoggerService;

  constructor(options: { custom: CustomObjectsApi; objects: KubernetesObjectApi; logger: LoggerService }) {
    this.#custom = options.custom;
    this.#objects = options.objects;
    this.#logger = options.logger;
  }

  /** Every cache (or one namespace's); empty when the ValkeyCache API isn't installed. */
  async list(namespace?: string): Promise<ValkeyCache[]> {
    try {
      const res = await kubeCall(() =>
        namespace
          ? this.#custom.listNamespacedCustomObject({ ...API, namespace })
          : this.#custom.listClusterCustomObject(API),
      );
      return (res.items ?? []) as ValkeyCache[];
    } catch (e) {
      if (e instanceof NotFoundError) return [];
      throw e;
    }
  }

  async get(namespace: string, name: string): Promise<ValkeyCache> {
    return (await kubeCall(
      () => this.#custom.getNamespacedCustomObject({ ...API, namespace, name }),
      `ValkeyCache ${namespace}/${name}`,
    )) as ValkeyCache;
  }

  /**
   * The cache with its pods and events from its location. A location that
   * can't be reached is reported in `unreachable` instead of failing the page.
   */
  async details(namespace: string, name: string, kubeConfigFor: LocationKubeConfig): Promise<ValkeyCacheDetails> {
    const resource = await this.get(namespace, name);
    const summary = summarizeCache(resource);
    if (!summary.location) return { summary, resource, pods: [], events: [] };
    try {
      const core = (await kubeConfigFor(summary.location)).makeApiClient(CoreV1Api);
      const [pods, events] = await Promise.all([
        this.#pods(core, summary.location, namespace, name),
        this.#events(core, summary.location, namespace, name),
      ]);
      return { summary, resource, pods, events };
    } catch (e) {
      return { summary, resource, pods: [], events: [], unreachable: (e as Error).message };
    }
  }

  /** The uri from the password Secret's copy in the location. */
  async connection(namespace: string, name: string, kubeConfigFor: LocationKubeConfig): Promise<CacheConnection> {
    const summary = summarizeCache(await this.get(namespace, name));
    if (!summary.location) throw new NotFoundError(`Cache ${namespace}/${name} isn't placed yet`);
    const core = (await kubeConfigFor(summary.location)).makeApiClient(CoreV1Api);
    const secretName = `${summary.secret ?? `${name}-valkey`}-auth`;
    const secret = await kubeCall(
      () => core.readNamespacedSecret({ namespace, name: secretName }),
      `Secret ${namespace}/${secretName} in ${summary.location}`,
    );
    const raw = secret.data?.uri;
    if (!raw) throw new NotFoundError(`Secret ${namespace}/${secretName} in ${summary.location} has no uri`);
    return { uri: Buffer.from(raw, 'base64').toString('utf8'), location: summary.location };
  }

  /** Creates or updates a ValkeyCache with server-side apply; the API server validates the spec. */
  async apply(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string>;
    createOnly?: boolean;
    dryRun?: boolean;
  }): Promise<ValkeyCache> {
    const { namespace, name, spec, labels, createOnly, dryRun } = options;
    if (createOnly) {
      const existing = await this.get(namespace, name).catch(e => {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      });
      if (existing) throw new ConflictError(`ValkeyCache ${namespace}/${name} already exists`);
    }
    const body = {
      apiVersion: `${CACHE_GROUP}/${CACHE_VERSION}`,
      kind: CACHE_KIND,
      metadata: { name, namespace, labels: { ...labels, 'app.kubernetes.io/managed-by': 'backstage' } },
      spec,
    };
    const result = await kubeCall(() =>
      this.#objects.patch(body, undefined, dryRun ? 'All' : undefined, FIELD_MANAGER, true, PatchStrategy.ServerSideApply),
    );
    if (!dryRun) this.#logger.info(`Applied ValkeyCache ${namespace}/${name}`);
    return result as unknown as ValkeyCache;
  }

  /** Changes an existing cache with a JSON merge patch (null removes a field, so its default applies). */
  async patch(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string | null>;
    dryRun?: boolean;
  }): Promise<ValkeyCache> {
    const { namespace, name, spec, labels, dryRun } = options;
    await this.get(namespace, name);
    const body = {
      apiVersion: `${CACHE_GROUP}/${CACHE_VERSION}`,
      kind: CACHE_KIND,
      metadata: { name, namespace, ...(labels ? { labels } : {}) },
      spec,
    };
    const result = await kubeCall(() =>
      this.#objects.patch(
        body as KubernetesObject,
        undefined,
        dryRun ? 'All' : undefined,
        FIELD_MANAGER,
        undefined,
        PatchStrategy.MergePatch,
      ),
    );
    if (!dryRun) this.#logger.info(`Patched ValkeyCache ${namespace}/${name}: ${JSON.stringify(spec)}`);
    return result as unknown as ValkeyCache;
  }

  async delete(namespace: string, name: string): Promise<void> {
    await kubeCall(
      () => this.#custom.deleteNamespacedCustomObject({ ...API, namespace, name, propagationPolicy: 'Foreground' }),
      `ValkeyCache ${namespace}/${name}`,
    );
    this.#logger.info(`Deleted ValkeyCache ${namespace}/${name}`);
  }

  async #pods(core: CoreV1Api, location: string, namespace: string, name: string): Promise<InstancePod[]> {
    const res = await kubeCall(() => core.listNamespacedPod({ namespace, labelSelector: cacheLabelSelector(name) }));
    return res.items
      .map(p => {
        const labels = p.metadata?.labels ?? {};
        const shard = labels['valkey.io/shard-index'];
        const node = labels['valkey.io/node-index'];
        return {
          name: p.metadata?.name ?? '',
          location,
          // node-index 0 started as the shard's primary; a failover can swap them.
          role: shard !== undefined ? `shard ${shard}, node ${node ?? '?'}` : 'unknown',
          phase: p.status?.phase ?? 'Unknown',
          ready: p.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ?? false,
          node: p.spec?.nodeName,
          restarts: (p.status?.containerStatuses ?? []).reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
          createdAt: toIso(p.metadata?.creationTimestamp),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async #events(core: CoreV1Api, location: string, namespace: string, name: string): Promise<ClusterEvent[]> {
    const res = await kubeCall(() => core.listNamespacedEvent({ namespace }));
    // The ValkeyCluster <name>, its ValkeyNodes, workloads and pods <name>-<shard>-<node>...,
    // and its Service valkey-<name>.
    const belongs = (obj = '') => obj === name || obj.startsWith(`${name}-`) || obj === `valkey-${name}`;
    return res.items
      .filter(e => belongs(e.involvedObject?.name))
      .map(e => ({
        location,
        type: e.type ?? 'Normal',
        reason: e.reason ?? '',
        message: e.message ?? '',
        object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
        count: e.count ?? 1,
        lastSeen: toIso(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp),
      }))
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
      .slice(0, 15);
  }
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export const valkeyServiceRef = createServiceRef<ValkeyService>({
  id: 'cnpg.valkey',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { logger: coreServices.logger, k8s: cnpgKubernetesServiceRef },
      factory: ({ logger, k8s }) =>
        new ValkeyService({
          custom: k8s.kubeConfig.makeApiClient(CustomObjectsApi),
          objects: KubernetesObjectApi.makeApiClient(k8s.kubeConfig),
          logger,
        }),
    }),
});
