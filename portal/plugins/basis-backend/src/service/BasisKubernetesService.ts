import {
  coreServices,
  createServiceFactory,
  createServiceRef,
  LoggerService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import {
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError,
} from '@backstage/errors';
import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  KubernetesObject,
  KubernetesObjectApi,
  PatchStrategy,
} from '@kubernetes/client-node';
import {
  ClusterConnection,
  ClusterEvent,
  clusterLocations,
  InstancePod,
  PodLogs,
  PostgresCluster,
  PostgresClusterDetails,
  Project,
  PROJECT_GROUP,
  PROJECT_KIND,
  PROJECT_PLURAL,
  PROJECT_VERSION,
  EXTENSIONS_GROUP,
  EXTENSIONS_NAME,
  EXTENSIONS_PLURAL,
  EXTENSIONS_VERSION,
  summarize,
  XR_GROUP,
  XR_KIND,
  XR_PLURAL,
  XR_VERSION,
} from '@internal/backstage-plugin-basis-common';

const FIELD_MANAGER = 'backstage-basis';

/** Credentials for a location's Kubernetes API; LocationService.kubeConfig in the plugin. */
export type LocationKubeConfig = (location: string) => Promise<KubeConfig>;

/**
 * Talks to the Kubernetes API of the platform cluster that runs Crossplane +
 * CNPG. Credentials come from the in-cluster ServiceAccount when Backstage
 * runs inside Kubernetes, otherwise from the local kubeconfig (optionally a
 * specific context via `basis.kubernetes.context`).
 */
export class BasisKubernetesService {
  readonly #custom: CustomObjectsApi;
  readonly #core: CoreV1Api;
  readonly #objects: KubernetesObjectApi;
  readonly #logger: LoggerService;
  /** The platform cluster's credentials; other services in this plugin share them. */
  readonly kubeConfig: KubeConfig;

  static fromConfig(config: RootConfigService, logger: LoggerService) {
    const kc = new KubeConfig();
    const kubeconfigPath = config.getOptionalString('basis.kubernetes.kubeconfig');
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      kc.loadFromDefault();
    }
    const context = config.getOptionalString('basis.kubernetes.context');
    if (context) {
      kc.setCurrentContext(context);
    }
    logger.info(
      `Using Kubernetes cluster ${kc.getCurrentCluster()?.server ?? '(unknown)'} for PostgresClusters`,
    );
    return new BasisKubernetesService(kc, logger);
  }

  constructor(kc: KubeConfig, logger: LoggerService) {
    this.#custom = kc.makeApiClient(CustomObjectsApi);
    this.#core = kc.makeApiClient(CoreV1Api);
    this.#objects = KubernetesObjectApi.makeApiClient(kc);
    this.#logger = logger;
    this.kubeConfig = kc;
  }

  async list(namespace?: string): Promise<PostgresCluster[]> {
    const res = await this.#call(() =>
      namespace
        ? this.#custom.listNamespacedCustomObject({
            group: XR_GROUP,
            version: XR_VERSION,
            plural: XR_PLURAL,
            namespace,
          })
        : this.#custom.listClusterCustomObject({
            group: XR_GROUP,
            version: XR_VERSION,
            plural: XR_PLURAL,
          }),
    );
    return (res.items ?? []) as PostgresCluster[];
  }

  async get(namespace: string, name: string): Promise<PostgresCluster> {
    return (await this.#call(
      () =>
        this.#custom.getNamespacedCustomObject({
          group: XR_GROUP,
          version: XR_VERSION,
          plural: XR_PLURAL,
          namespace,
          name,
        }),
      `PostgresCluster ${namespace}/${name}`,
    )) as PostgresCluster;
  }

  /**
   * The cluster with its pods and events from every location it runs in,
   * and the live CNPG status from the primary's. A location that can't be
   * reached is listed in `unreachable` instead of failing the whole page.
   */
  async details(
    namespace: string,
    name: string,
    kubeConfigFor?: LocationKubeConfig,
  ): Promise<PostgresClusterDetails> {
    const resource = await this.get(namespace, name);
    const summary = summarize(resource);
    const unreachable: NonNullable<PostgresClusterDetails['unreachable']> = [];
    const perLocation = await Promise.all(
      clusterLocations(resource).map(async location => {
        try {
          const kc = await this.#kubeConfig(location, kubeConfigFor);
          const core = kc.makeApiClient(CoreV1Api);
          const custom = kc.makeApiClient(CustomObjectsApi);
          const primary = location === summary.primaryLocation;
          const [pods, events, cnpg, externalHost] = await Promise.all([
            this.#pods(core, location, namespace, name),
            this.#events(core, location, namespace, name),
            primary
              ? custom
                  .getNamespacedCustomObject({
                    group: 'postgresql.cnpg.io',
                    version: 'v1',
                    plural: 'clusters',
                    namespace,
                    name,
                  })
                  .catch(() => undefined)
              : undefined,
            primary ? this.#externalHost(core, namespace, name) : undefined,
          ]);
          return { pods, events, cnpgStatus: cnpg?.status, externalHost };
        } catch (e) {
          unreachable.push({ location, message: (e as Error).message });
          return { pods: [], events: [], cnpgStatus: undefined, externalHost: undefined };
        }
      }),
    );
    return {
      summary,
      resource,
      pods: perLocation.flatMap(l => l.pods),
      events: perLocation
        .flatMap(l => l.events)
        .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
        .slice(0, 15),
      cnpgStatus: perLocation.find(l => l.cnpgStatus)?.cnpgStatus,
      externalHost: perLocation.find(l => l.externalHost)?.externalHost,
      ...(unreachable.length ? { unreachable } : {}),
    };
  }

  /**
   * The tail of one of the cluster's pods' stdout. The pod must carry the
   * cluster's label, so read access to a cluster never exposes the logs of
   * other pods in its namespace. Instance pods log from the "postgres"
   * container; other pods (bootstrap jobs) from their first one.
   */
  async logs(
    namespace: string,
    name: string,
    options: {
      pod: string;
      location?: string;
      tailLines: number;
      sinceSeconds?: number;
      previous?: boolean;
    },
    kubeConfigFor?: LocationKubeConfig,
  ): Promise<PodLogs> {
    const { pod, tailLines, sinceSeconds, previous } = options;
    const cluster = await this.get(namespace, name);
    const location = options.location ?? summarize(cluster).primaryLocation;
    // Only the cluster's own locations: the location parameter must not
    // become a way to read pods in arbitrary clusters.
    if (!location || !clusterLocations(cluster).includes(location)) {
      throw new NotFoundError(`Cluster ${namespace}/${name} doesn't run in location ${location || '(none yet)'}`);
    }
    const core = (await this.#kubeConfig(location, kubeConfigFor)).makeApiClient(CoreV1Api);
    const what = `Pod ${namespace}/${pod} of cluster ${name} in ${location}`;
    const p = await this.#call(() => core.readNamespacedPod({ namespace, name: pod }), what);
    if (p.metadata?.labels?.['cnpg.io/cluster'] !== name) {
      throw new NotFoundError(`${what} not found`);
    }
    const containers = (p.spec?.containers ?? []).map(c => c.name);
    const container = containers.includes('postgres') ? 'postgres' : containers[0];
    const text = await this.#call(() =>
      core.readNamespacedPodLog({
        namespace,
        name: pod,
        container,
        tailLines,
        sinceSeconds,
        previous,
        // A few thousand verbose lines; keeps one request from pulling megabytes.
        limitBytes: 4 * 1024 * 1024,
      }),
    );
    return { pod, location, container: container ?? '', text: text ?? '' };
  }

  /**
   * The app Secret's URI from the primary's location, with its in-cluster
   * host swapped for the "<name>-external" load balancer's address. Read
   * live, so it follows a switchover and a changed LB IP.
   */
  async connection(
    namespace: string,
    name: string,
    kubeConfigFor?: LocationKubeConfig,
  ): Promise<ClusterConnection> {
    const cluster = await this.get(namespace, name);
    const location = summarize(cluster).primaryLocation;
    if (!location) throw new NotFoundError(`Cluster ${namespace}/${name} isn't placed yet`);
    const core = (await this.#kubeConfig(location, kubeConfigFor)).makeApiClient(CoreV1Api);
    const secretName = cluster.status?.secrets?.app || `${name}-app`;
    const [secret, host] = await Promise.all([
      this.#call(
        () => core.readNamespacedSecret({ namespace, name: secretName }),
        `Secret ${namespace}/${secretName} in ${location}`,
      ),
      this.#externalHost(core, namespace, name),
    ]);
    const raw = secret.data?.uri;
    if (!raw) throw new NotFoundError(`Secret ${namespace}/${secretName} in ${location} has no uri`);
    const uri = new URL(Buffer.from(raw, 'base64').toString('utf8'));
    if (host) uri.hostname = host.includes(':') ? `[${host}]` : host;
    return { uri: uri.toString(), location, external: !!host };
  }

  /**
   * Creates or updates a PostgresCluster with server-side apply. The spec is
   * passed through as-is: the API server validates it against the XRD schema
   * (defaults, enums, CEL rules) and its errors are returned to the caller.
   */
  async apply(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string>;
    createOnly?: boolean;
    dryRun?: boolean;
  }): Promise<PostgresCluster> {
    const { namespace, name, spec, labels, createOnly, dryRun } = options;
    if (createOnly) {
      const existing = await this.get(namespace, name).catch(e => {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      });
      if (existing) {
        throw new ConflictError(`PostgresCluster ${namespace}/${name} already exists`);
      }
    }
    const body = {
      apiVersion: `${XR_GROUP}/${XR_VERSION}`,
      kind: XR_KIND,
      metadata: {
        name,
        namespace,
        labels: { ...labels, 'app.kubernetes.io/managed-by': 'backstage' },
      },
      spec,
    };
    const result = await this.#call(() =>
      this.#objects.patch(
        body,
        undefined,
        dryRun ? 'All' : undefined,
        FIELD_MANAGER,
        true,
        PatchStrategy.ServerSideApply,
      ),
    );
    if (!dryRun) {
      this.#logger.info(`Applied PostgresCluster ${namespace}/${name}`);
    }
    return result as unknown as PostgresCluster;
  }

  /**
   * Changes an existing PostgresCluster with a JSON merge patch: only the
   * fields in `spec` change (null removes one, so its XRD default applies
   * again), whoever set the others. The XRD rejects changes the cluster
   * can't take in place, such as shrinking a volume.
   */
  async patch(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string | null>;
    dryRun?: boolean;
  }): Promise<PostgresCluster> {
    const { namespace, name, spec, labels, dryRun } = options;
    // A merge patch on a missing object would fail with a less helpful message.
    await this.get(namespace, name);
    const body = {
      apiVersion: `${XR_GROUP}/${XR_VERSION}`,
      kind: XR_KIND,
      metadata: { name, namespace, ...(labels ? { labels } : {}) },
      spec,
    };
    const result = await this.#mergePatch(body, dryRun);
    if (!dryRun) {
      this.#logger.info(`Patched PostgresCluster ${namespace}/${name}: ${JSON.stringify(spec)}`);
    }
    return result as unknown as PostgresCluster;
  }

  async delete(namespace: string, name: string): Promise<void> {
    await this.#call(
      () =>
        this.#custom.deleteNamespacedCustomObject({
          group: XR_GROUP,
          version: XR_VERSION,
          plural: XR_PLURAL,
          namespace,
          name,
          propagationPolicy: 'Foreground',
        }),
      `PostgresCluster ${namespace}/${name}`,
    );
    this.#logger.info(`Deleted PostgresCluster ${namespace}/${name}`);
  }

  /**
   * Deletes a Project, turning its deletionProtection off first (the
   * admission policy refuses the delete otherwise). Callers check that it
   * has no PostgresClusters left: its namespace goes with it.
   */
  async deleteProject(name: string): Promise<void> {
    const project = await this.getProject(name);
    if (project.spec.deletionProtection !== false) {
      await this.patchProject({ name, spec: { deletionProtection: false } });
    }
    await this.#call(
      () =>
        this.#custom.deleteClusterCustomObject({
          group: PROJECT_GROUP,
          version: PROJECT_VERSION,
          plural: PROJECT_PLURAL,
          name,
          propagationPolicy: 'Foreground',
        }),
      `Project ${name}`,
    );
    this.#logger.info(`Deleted Project ${name}`);
  }

  /**
   * Every Project. An empty list when the Project API isn't installed, so
   * the portal keeps working on clusters with only the PostgresCluster API.
   */
  async listProjects(): Promise<Project[]> {
    try {
      const res = await this.#call(() =>
        this.#custom.listClusterCustomObject({
          group: PROJECT_GROUP,
          version: PROJECT_VERSION,
          plural: PROJECT_PLURAL,
        }),
      );
      return (res.items ?? []) as Project[];
    } catch (e) {
      if (e instanceof NotFoundError) return [];
      throw e;
    }
  }

  /**
   * data of the postgres-extensions EnvironmentConfig (the extensions a
   * cluster may add); undefined when there's none.
   */
  async extensionsCatalog(): Promise<unknown> {
    return this.#environmentConfigData(EXTENSIONS_NAME);
  }

  async #environmentConfigData(name: string): Promise<unknown> {
    try {
      const res = await this.#call(() =>
        this.#custom.getClusterCustomObject({
          group: EXTENSIONS_GROUP,
          version: EXTENSIONS_VERSION,
          plural: EXTENSIONS_PLURAL,
          name,
        }),
      );
      return (res as { data?: unknown }).data;
    } catch (e) {
      if (e instanceof NotFoundError) return undefined;
      throw e;
    }
  }

  async getProject(name: string): Promise<Project> {
    return (await this.#call(
      () =>
        this.#custom.getClusterCustomObject({
          group: PROJECT_GROUP,
          version: PROJECT_VERSION,
          plural: PROJECT_PLURAL,
          name,
        }),
      `Project ${name}`,
    )) as Project;
  }

  /**
   * Creates a Project with server-side apply; like {@link apply}, the API
   * server validates the spec (and the name) against the XRD.
   */
  async applyProject(options: {
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string>;
    createOnly?: boolean;
    dryRun?: boolean;
  }): Promise<Project> {
    const { name, spec, labels, createOnly, dryRun } = options;
    if (createOnly) {
      const existing = await this.getProject(name).catch(e => {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      });
      if (existing) {
        throw new ConflictError(`Project ${name} already exists`);
      }
    }
    const body = {
      apiVersion: `${PROJECT_GROUP}/${PROJECT_VERSION}`,
      kind: PROJECT_KIND,
      metadata: {
        name,
        labels: { ...labels, 'app.kubernetes.io/managed-by': 'backstage' },
      },
      spec,
    };
    const result = await this.#call(() =>
      this.#objects.patch(
        body,
        undefined,
        dryRun ? 'All' : undefined,
        FIELD_MANAGER,
        true,
        PatchStrategy.ServerSideApply,
      ),
    );
    if (!dryRun) {
      this.#logger.info(`Applied Project ${name}`);
    }
    return result as unknown as Project;
  }

  /** Changes an existing Project with a JSON merge patch, like {@link patch}. */
  async patchProject(options: {
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string | null>;
    dryRun?: boolean;
  }): Promise<Project> {
    const { name, spec, labels, dryRun } = options;
    await this.getProject(name);
    const body = {
      apiVersion: `${PROJECT_GROUP}/${PROJECT_VERSION}`,
      kind: PROJECT_KIND,
      metadata: { name, ...(labels ? { labels } : {}) },
      spec,
    };
    const result = await this.#mergePatch(body, dryRun);
    if (!dryRun) {
      this.#logger.info(`Patched Project ${name}: ${JSON.stringify(spec)}`);
    }
    return result as unknown as Project;
  }

  /**
   * Why a project's backup check last failed in a location (the Project
   * composition's CronJob backup-check there): the tail of its newest pod's
   * log, why that pod never started, or, when the pod is gone, its Job's
   * failure.
   */
  async backupCheckDetail(
    project: string,
    location: string,
    kubeConfigFor: LocationKubeConfig,
  ): Promise<string | undefined> {
    const kc = await this.#kubeConfig(location, kubeConfigFor);
    const core = kc.makeApiClient(CoreV1Api);
    const pods = await this.#call(() =>
      core.listNamespacedPod({ namespace: project, labelSelector: 'platform.cndev.nl/check=backup' }),
    );
    const newest = <T extends { metadata?: { creationTimestamp?: Date } }>(items: T[]) =>
      items.sort(
        (a, b) =>
          (b.metadata?.creationTimestamp?.getTime() ?? 0) - (a.metadata?.creationTimestamp?.getTime() ?? 0),
      )[0];
    const pod = newest(pods.items);
    if (pod) {
      const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting;
      if (waiting?.reason) return `${waiting.reason}: ${waiting.message ?? ''}`.trim();
      const text = await this.#call(() =>
        core.readNamespacedPodLog({
          namespace: project,
          name: pod.metadata?.name ?? '',
          tailLines: 5,
          limitBytes: 16 * 1024,
        }),
      );
      if (text?.trim()) return text.trim();
    }
    const jobs = await this.#call(() =>
      kc.makeApiClient(BatchV1Api).listNamespacedJob({ namespace: project }),
    );
    const job = newest(
      jobs.items.filter(j => j.metadata?.ownerReferences?.some(o => o.kind === 'CronJob' && o.name === 'backup-check')),
    );
    return job?.status?.conditions?.find(c => c.type === 'Failed' && c.status === 'True')?.message;
  }

  async namespaces(): Promise<string[]> {
    const res = await this.#call(() => this.#core.listNamespace());
    return res.items
      .map(n => n.metadata?.name ?? '')
      .filter(n => n && !n.startsWith('kube-'))
      .sort();
  }

  async #kubeConfig(location: string, kubeConfigFor?: LocationKubeConfig): Promise<KubeConfig> {
    if (!kubeConfigFor) throw new NotFoundError(`Location ${location} not found`);
    return kubeConfigFor(location);
  }

  async #pods(
    core: CoreV1Api,
    location: string,
    namespace: string,
    name: string,
  ): Promise<InstancePod[]> {
    const res = await this.#call(() =>
      core.listNamespacedPod({
        namespace,
        labelSelector: `cnpg.io/cluster=${name}`,
      }),
    );
    const label = (p: (typeof res.items)[number], key: string) => p.metadata?.labels?.[key];
    return res.items
      // Finished bootstrap/join Job pods (initdb, join, ...) are just noise.
      .filter(p => !(label(p, 'cnpg.io/jobRole') && p.status?.phase === 'Succeeded'))
      .map(p => ({
        name: p.metadata?.name ?? '',
        location,
        role:
          label(p, 'cnpg.io/instanceRole') ??
          (label(p, 'cnpg.io/jobRole') ? `job: ${label(p, 'cnpg.io/jobRole')}` : undefined) ??
          label(p, 'cnpg.io/podRole') ??
          'unknown',
        phase: p.status?.phase ?? 'Unknown',
        ready:
          p.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ??
          false,
        node: p.spec?.nodeName,
        restarts: (p.status?.containerStatuses ?? []).reduce(
          (sum, c) => sum + (c.restartCount ?? 0),
          0,
        ),
        createdAt: toIso(p.metadata?.creationTimestamp),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The LB address of the "<name>-external" read-write service, if it has one yet. */
  async #externalHost(
    core: CoreV1Api,
    namespace: string,
    name: string,
  ): Promise<string | undefined> {
    const svc = await core
      .readNamespacedService({ namespace, name: `${name}-external` })
      .catch(() => undefined);
    const ingress = svc?.status?.loadBalancer?.ingress?.[0];
    return ingress?.ip || ingress?.hostname || undefined;
  }

  async #events(
    core: CoreV1Api,
    location: string,
    namespace: string,
    name: string,
  ): Promise<ClusterEvent[]> {
    const res = await this.#call(() => core.listNamespacedEvent({ namespace }));
    // The XR, the Cluster, poolers, backups, pods and PVCs are all named
    // "<name>" or "<name>-...".
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
      }))
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
      .slice(0, 15);
  }

  /** null label values remove the label, which KubernetesObject's types don't allow for. */
  #mergePatch(body: object, dryRun?: boolean) {
    return this.#call(() =>
      this.#objects.patch(
        body as KubernetesObject,
        undefined,
        dryRun ? 'All' : undefined,
        FIELD_MANAGER,
        undefined,
        PatchStrategy.MergePatch,
      ),
    );
  }

  #call<T>(fn: () => Promise<T>, what?: string): Promise<T> {
    return kubeCall(fn, what);
  }
}

/** Maps Kubernetes API errors onto Backstage's error types (and HTTP codes). */
export async function kubeCall<T>(fn: () => Promise<T>, what?: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiException) {
      const message = apiMessage(e);
      switch (e.code) {
        case 404:
          throw new NotFoundError(what ? `${what} not found` : message);
        case 409:
          throw new ConflictError(message);
        case 400:
        case 422:
          throw new InputError(message);
        case 401:
        case 403:
          throw new NotAllowedError(message);
        default:
          throw new Error(`Kubernetes API error ${e.code}: ${message}`);
      }
    }
    throw e;
  }
}

export function apiMessage(e: ApiException<unknown>): string {
  const body = e.body as any;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body).message ?? body;
    } catch {
      return body;
    }
  }
  return body?.message ?? e.message;
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export const basisKubernetesServiceRef = createServiceRef<BasisKubernetesService>({
  id: 'basis.kubernetes',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { config: coreServices.rootConfig, logger: coreServices.logger },
      factory: ({ config, logger }) => BasisKubernetesService.fromConfig(config, logger),
    }),
});
