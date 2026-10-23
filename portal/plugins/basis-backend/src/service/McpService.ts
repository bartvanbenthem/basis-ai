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
  ClusterEvent,
  InstancePod,
  MCP_GROUP,
  MCP_KIND,
  MCP_PLURAL,
  MCP_VERSION,
  MCPServer,
  McpKey,
  mcpLabelSelector,
  summarizeMcpServer,
} from '@internal/backstage-plugin-basis-common';
import { basisKubernetesServiceRef, kubeCall, LocationKubeConfig } from './BasisKubernetesService';

const FIELD_MANAGER = 'backstage-basis';
const API = { group: MCP_GROUP, version: MCP_VERSION, plural: MCP_PLURAL };

/**
 * MCPServers (ai.cndev.nl) on the control plane, and their pods and events
 * in the locations of their sites. The clients' keys are read from the copy
 * in the active site's location (as gateways' are), so the portal needs no
 * Secret access on the control plane. Every write goes through the XR, so
 * the API server validates it against the XRD and the admission policies.
 */
export class McpService {
  readonly #custom: CustomObjectsApi;
  readonly #objects: KubernetesObjectApi;
  readonly #logger: LoggerService;

  constructor(options: { custom: CustomObjectsApi; objects: KubernetesObjectApi; logger: LoggerService }) {
    this.#custom = options.custom;
    this.#objects = options.objects;
    this.#logger = options.logger;
  }

  /** Every server (or one namespace's); empty when the MCPServer API isn't installed. */
  async list(namespace?: string): Promise<MCPServer[]> {
    try {
      const res = await kubeCall(() =>
        namespace
          ? this.#custom.listNamespacedCustomObject({ ...API, namespace })
          : this.#custom.listClusterCustomObject(API),
      );
      return (res.items ?? []) as MCPServer[];
    } catch (e) {
      if (e instanceof NotFoundError) return [];
      throw e;
    }
  }

  async get(namespace: string, name: string): Promise<MCPServer> {
    return (await kubeCall(
      () => this.#custom.getNamespacedCustomObject({ ...API, namespace, name }),
      `MCPServer ${namespace}/${name}`,
    )) as MCPServer;
  }

  /** The clients' API keys, from the keys Secret's copy in the active site's location. */
  async keys(namespace: string, name: string, kubeConfigFor: LocationKubeConfig): Promise<McpKey[]> {
    const summary = summarizeMcpServer(await this.get(namespace, name));
    const site = summary.sites.find(s => s.active) ?? summary.sites[0];
    if (!site?.location) throw new NotFoundError(`MCP server ${namespace}/${name} isn't placed yet`);
    const core = (await kubeConfigFor(site.location)).makeApiClient(CoreV1Api);
    const secret = await kubeCall(
      () => core.readNamespacedSecret({ namespace, name: summary.keysSecret }),
      `Secret ${namespace}/${summary.keysSecret} in ${site.location}`,
    );
    return Object.entries(secret.data ?? {})
      .map(([client, v]) => ({ client, key: Buffer.from(v, 'base64').toString('utf8') }))
      .sort((a, b) => a.client.localeCompare(b.client));
  }

  /**
   * The server's pods and events in every site's location. A location that
   * can't be reached is reported in `unreachable` instead of failing the page.
   */
  async workload(
    server: MCPServer,
    kubeConfigFor: LocationKubeConfig,
  ): Promise<{ pods: InstancePod[]; events: ClusterEvent[]; unreachable?: string }> {
    const { namespace, name } = server.metadata;
    const sites = summarizeMcpServer(server).sites;
    const locations = Array.from(new Set(sites.map(s => s.location).filter(Boolean)));
    const pods: InstancePod[] = [];
    const events: ClusterEvent[] = [];
    const failed: string[] = [];
    await Promise.all(
      locations.map(async location => {
        try {
          const core = (await kubeConfigFor(location)).makeApiClient(CoreV1Api);
          const role = sites.find(s => s.location === location)?.active ? 'active' : 'standby';
          const [p, e] = await Promise.all([
            this.#pods(core, location, namespace, name, role),
            this.#events(core, location, namespace, name),
          ]);
          pods.push(...p);
          events.push(...e);
        } catch (e) {
          failed.push(`${location}: ${(e as Error).message}`);
        }
      }),
    );
    return {
      pods: pods.sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name)),
      events: events.sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')).slice(0, 20),
      ...(failed.length ? { unreachable: failed.sort().join('; ') } : {}),
    };
  }

  /** Creates or updates a server with server-side apply. */
  async apply(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string>;
    createOnly?: boolean;
    dryRun?: boolean;
  }): Promise<MCPServer> {
    const { namespace, name, spec, labels, createOnly, dryRun } = options;
    if (createOnly) {
      const existing = await this.get(namespace, name).catch(e => {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      });
      if (existing) throw new ConflictError(`MCPServer ${namespace}/${name} already exists`);
    }
    const body = {
      apiVersion: `${MCP_GROUP}/${MCP_VERSION}`,
      kind: MCP_KIND,
      metadata: { name, namespace, labels: { ...labels, 'app.kubernetes.io/managed-by': 'backstage' } },
      spec,
    };
    const result = await kubeCall(() =>
      this.#objects.patch(body, undefined, dryRun ? 'All' : undefined, FIELD_MANAGER, true, PatchStrategy.ServerSideApply),
    );
    if (!dryRun) this.#logger.info(`Applied MCPServer ${namespace}/${name}`);
    return result as unknown as MCPServer;
  }

  /** Changes an existing server with a JSON merge patch (null removes a field, so its default applies). */
  async patch(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string | null>;
    dryRun?: boolean;
  }): Promise<MCPServer> {
    const { namespace, name, spec, labels, dryRun } = options;
    await this.get(namespace, name);
    const body = {
      apiVersion: `${MCP_GROUP}/${MCP_VERSION}`,
      kind: MCP_KIND,
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
    if (!dryRun) this.#logger.info(`Patched MCPServer ${namespace}/${name}: ${JSON.stringify(spec)}`);
    return result as unknown as MCPServer;
  }

  async delete(namespace: string, name: string): Promise<void> {
    await kubeCall(
      () => this.#custom.deleteNamespacedCustomObject({ ...API, namespace, name, propagationPolicy: 'Foreground' }),
      `MCPServer ${namespace}/${name}`,
    );
    this.#logger.info(`Deleted MCPServer ${namespace}/${name}`);
  }

  async #pods(core: CoreV1Api, location: string, namespace: string, name: string, role: string): Promise<InstancePod[]> {
    const res = await kubeCall(() => core.listNamespacedPod({ namespace, labelSelector: mcpLabelSelector(name) }));
    return res.items.map(p => ({
      name: p.metadata?.name ?? '',
      location,
      role,
      phase: p.status?.phase ?? 'Unknown',
      ready: p.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ?? false,
      node: p.spec?.nodeName,
      restarts: (p.status?.containerStatuses ?? []).reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
      createdAt: toIso(p.metadata?.creationTimestamp),
    }));
  }

  async #events(core: CoreV1Api, location: string, namespace: string, name: string): Promise<ClusterEvent[]> {
    const res = await kubeCall(() => core.listNamespacedEvent({ namespace }));
    // The Deployment <name>, its ReplicaSets and pods <name>-..., and <name>-config / -keys.
    const belongs = (obj = '') => obj === name || obj.startsWith(`${name}-`);
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
      }));
  }
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export const mcpServiceRef = createServiceRef<McpService>({
  id: 'basis.mcp',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { logger: coreServices.logger, k8s: basisKubernetesServiceRef },
      factory: ({ logger, k8s }) =>
        new McpService({
          custom: k8s.kubeConfig.makeApiClient(CustomObjectsApi),
          objects: KubernetesObjectApi.makeApiClient(k8s.kubeConfig),
          logger,
        }),
    }),
});
