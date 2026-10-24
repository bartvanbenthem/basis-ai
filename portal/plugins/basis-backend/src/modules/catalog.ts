import {
  coreServices,
  createBackendModule,
  LoggerService,
  RootConfigService,
  SchedulerServiceTaskRunner,
} from '@backstage/backend-plugin-api';
import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
  Entity,
} from '@backstage/catalog-model';
import {
  catalogProcessingExtensionPoint,
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import {
  BasisKubernetesService,
  basisKubernetesServiceRef,
} from '../service/BasisKubernetesService';
import { GatewayService, gatewayServiceRef } from '../service/GatewayService';
import { McpService, mcpServiceRef } from '../service/McpService';
import { ServerService, serverServiceRef } from '../service/ServerService';
import { StackService, stackServiceRef } from '../service/StackService';
import { ValkeyService, valkeyServiceRef } from '../service/ValkeyService';
import {
  CACHE_ANNOTATION,
  CACHE_MODES,
  cachePods,
  CLUSTER_ANNOTATION,
  GATEWAY_ANNOTATION,
  GenAIStack,
  MCP_ANNOTATION,
  MCPServer,
  ModelGateway,
  ModelServer,
  serverGPUs,
  PostgresCluster,
  STACK_ANNOTATION,
  summarizeStack,
  Project,
  PROJECT_ANNOTATION,
  ProjectSummary,
  summarize,
  summarizeCache,
  summarizeGateway,
  summarizeMcpServer,
  summarizeServer,
  summarizeProject,
  ValkeyCache,
} from '@internal/backstage-plugin-basis-common';

/**
 * Mirrors every Project and PostgresCluster into the catalog:
 *
 * - a Project becomes a Resource of type "project" named after the project
 *   (= namespace), owned by spec.owner. The create-cluster template picks
 *   one of these instead of a free-text namespace.
 * - a PostgresCluster becomes a Resource of type "postgres-cluster" named
 *   "<namespace>--<name>", owner/system from the backstage.io/owner and
 *   backstage.io/system labels on the XR, and dependsOn its project.
 * - a ValkeyCache becomes a Resource of type "valkey-cache" named
 *   "<namespace>--<name>.valkey", owned and linked the same way.
 * - a ModelGateway becomes a Resource of type "model-gateway" named
 *   "<namespace>--<name>.gateway", owned and linked the same way.
 * - a ModelServer becomes a Resource of type "model-server" named
 *   "<namespace>--<name>.server", owned and linked the same way.
 * - a GenAIStack becomes a Resource of type "genai-stack" named
 *   "<namespace>--<name>.stack", dependsOn its project, database, caches and
 *   gateway.
 * - an MCPServer becomes a Resource of type "mcp-server" named
 *   "<namespace>--<name>.mcp", dependsOn its project and the stack or
 *   cluster whose database it serves.
 *
 * Project names can't contain "--" (enforced by the XRD), and cluster,
 * cache, gateway, server and MCP server names no ".", so none of them collide.
 */
export class PostgresClusterEntityProvider implements EntityProvider {
  #connection?: EntityProviderConnection;

  constructor(
    private readonly k8s: BasisKubernetesService,
    private readonly taskRunner: SchedulerServiceTaskRunner,
    private readonly logger: LoggerService,
    private readonly options: { defaultOwner: string; appBaseUrl: string; grafanaUrl?: string },
    private readonly valkey?: Pick<ValkeyService, 'list'>,
    private readonly stacks?: Pick<StackService, 'list'>,
    private readonly gateways?: Pick<GatewayService, 'list'>,
    private readonly servers?: Pick<ServerService, 'list'>,
    private readonly mcp?: Pick<McpService, 'list'>,
  ) {}

  getProviderName() {
    return 'basis-catalog';
  }

  async connect(connection: EntityProviderConnection) {
    this.#connection = connection;
    await this.taskRunner.run({
      id: `${this.getProviderName()}:refresh`,
      fn: () => this.refresh(),
    });
  }

  async refresh() {
    if (!this.#connection) return;
    const [clusters, projects, caches, stacks, gateways, servers, mcpServers] = await Promise.all([
      this.k8s.list(),
      this.k8s.listProjects(),
      this.valkey?.list() ?? Promise.resolve([]),
      this.stacks?.list() ?? Promise.resolve([]),
      this.gateways?.list() ?? Promise.resolve([]),
      this.servers?.list() ?? Promise.resolve([]),
      this.mcp?.list() ?? Promise.resolve([]),
    ]);
    const byName = new Map(projects.map(p => [p.metadata.name, summarizeProject(p)]));
    const entities = [
      ...projects.map(p => this.toProjectEntity(p)),
      ...clusters.map(c => this.toEntity(c, byName.get(c.metadata.namespace))),
      ...caches.map(c => this.toCacheEntity(c, byName.get(c.metadata.namespace))),
      ...stacks.map(s => this.toStackEntity(s, byName.get(s.metadata.namespace))),
      ...gateways.map(g => this.toGatewayEntity(g, byName.get(g.metadata.namespace))),
      ...servers.map(s => this.toServerEntity(s, byName.get(s.metadata.namespace))),
      ...mcpServers.map(m => this.toMcpEntity(m, byName.get(m.metadata.namespace))),
    ];
    await this.#connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({ entity, locationKey: this.getProviderName() })),
    });
    this.logger.debug(
      `Synced ${projects.length} Projects, ${clusters.length} PostgresClusters, ${caches.length} ValkeyCaches, ${gateways.length} ModelGateways, ${servers.length} ModelServers, ${mcpServers.length} MCPServers and ${stacks.length} GenAIStacks into the catalog`,
    );
  }

  toProjectEntity(project: Project): Entity {
    const s = summarizeProject(project);
    const location = `basis:project/${s.name}`;
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/basis/projects/${s.name}`,
        title: 'BASIS portal',
      },
    ];
    if (s.grafanaUrl) {
      links.push({ url: s.grafanaUrl, title: 'Grafana' });
    }
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: s.name,
        title: s.name,
        description: s.description ?? `Project ${s.name} with its own Prometheus and Grafana`,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          [PROJECT_ANNOTATION]: s.name,
          'backstage.io/kubernetes-namespace': s.name,
        },
        tags: ['project'],
        links,
      },
      spec: {
        type: 'project',
        owner: s.owner ?? this.options.defaultOwner,
      },
    };
  }

  /** `project`: the Project whose namespace the cluster is in, if any. */
  toEntity(cluster: PostgresCluster, project?: ProjectSummary): Entity {
    const { name, namespace, labels = {} } = cluster.metadata;
    const s = summarize(cluster);
    const location = `basis:${namespace}/${name}`;
    const dashboardUid = cluster.status?.monitoring?.dashboardUid;
    // Entity links must be absolute URLs.
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/basis/${namespace}/${name}`,
        title: 'BASIS portal',
      },
    ];
    // The project's own Grafana, else the configured one ("{namespace}" for
    // one Grafana per namespace).
    const grafanaUrl =
      project?.grafanaUrl ?? this.options.grafanaUrl?.replace(/\{namespace\}/g, namespace);
    if (dashboardUid && grafanaUrl) {
      links.push({
        url: `${grafanaUrl.replace(/\/$/, '')}/d/${dashboardUid}`,
        title: 'Grafana dashboard',
      });
    }
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        // Entity names are unique per catalog namespace, cluster names only
        // per Kubernetes namespace -- so include both.
        name: `${namespace}--${name}`.slice(0, 63),
        title: `${name} (${namespace})`,
        description: `PostgreSQL ${s.postgresVersion ?? ''} on CloudNativePG, ${s.instances} instance(s)${s.size ? ` of size ${s.size}` : ''}`,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          [CLUSTER_ANNOTATION]: `${namespace}/${name}`,
          'backstage.io/kubernetes-id': name,
          'backstage.io/kubernetes-namespace': namespace,
        },
        tags: [
          'postgresql',
          'cnpg',
          `pg${s.postgresVersion ?? ''}`,
          ...(s.size ? [`size-${s.size}`] : []),
        ].filter(t => t !== 'pg'),
        links,
      },
      spec: {
        type: 'postgres-cluster',
        owner: labels['backstage.io/owner'] ?? this.options.defaultOwner,
        ...(labels['backstage.io/system'] ? { system: labels['backstage.io/system'] } : {}),
        ...(project ? { dependsOn: [`resource:default/${project.name}`] } : {}),
      },
    };
  }
  /** `project`: the Project whose namespace the stack is in, if any. */
  toStackEntity(stack: GenAIStack, project?: ProjectSummary): Entity {
    const { name, namespace, labels = {} } = stack.metadata;
    const s = summarizeStack(stack);
    const location = `basis:stack/${namespace}/${name}`;
    let gateway = '';
    if (s.gateway) gateway = s.sharedGateway ? `, shared gateway ${s.gatewayName}` : `, gateway with ${s.models.length} model(s)`;
    // Its database, caches and gateway are entities of their own, named as
    // toEntity / toCacheEntity / toGatewayEntity name them.
    const dependsOn = [
      ...(project ? [`resource:default/${project.name}`] : []),
      `resource:default/${`${namespace}--${s.database}`.slice(0, 63)}`,
      ...[s.cacheName, s.recoveryCacheName]
        .filter((c): c is string => Boolean(c))
        .map(c => `resource:default/${`${namespace}--${c}.valkey`.slice(0, 63)}`),
      ...(s.gatewayName ? [`resource:default/${`${namespace}--${s.gatewayName}.gateway`.slice(0, 63)}`] : []),
    ];
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: `${namespace}--${name}.stack`.slice(0, 63),
        title: `${name} (${namespace})`,
        description: `GenAI stack: retrieval (pgvector)${s.cache ? `, ${s.cacheMode} cache` : ''}${gateway}${s.recovery ? ', warm standby in the recovery site' : ''}`,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          [STACK_ANNOTATION]: `${namespace}/${name}`,
          'backstage.io/kubernetes-namespace': namespace,
        },
        tags: ['genai', 'rag', ...(s.recovery ? ['geo-redundant'] : [])],
        links: [
          {
            url: `${this.options.appBaseUrl.replace(/\/$/, '')}/basis/stacks/${namespace}/${name}`,
            title: 'BASIS portal',
          },
        ],
      },
      spec: {
        type: 'genai-stack',
        owner: labels['backstage.io/owner'] ?? this.options.defaultOwner,
        ...(labels['backstage.io/system'] ? { system: labels['backstage.io/system'] } : {}),
        dependsOn,
      },
    };
  }

  /** `project`: the Project whose namespace the gateway is in, if any. */
  toGatewayEntity(gateway: ModelGateway, project?: ProjectSummary): Entity {
    const { name, namespace, labels = {} } = gateway.metadata;
    const s = summarizeGateway(gateway);
    const location = `basis:gateway/${namespace}/${name}`;
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: `${namespace}--${name}.gateway`.slice(0, 63),
        title: `${name} (${namespace})`,
        description: `Model gateway (Agent Router): ${s.models.length} model(s), ${s.clients.length} client(s)${s.recovery ? ', standby in the recovery site' : ''}`,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          [GATEWAY_ANNOTATION]: `${namespace}/${name}`,
          'backstage.io/kubernetes-namespace': namespace,
        },
        tags: ['genai', 'llm', 'gateway'],
        links: [
          {
            url: `${this.options.appBaseUrl.replace(/\/$/, '')}/basis/gateways/${namespace}/${name}`,
            title: 'BASIS portal',
          },
        ],
      },
      spec: {
        type: 'model-gateway',
        owner: labels['backstage.io/owner'] ?? this.options.defaultOwner,
        ...(labels['backstage.io/system'] ? { system: labels['backstage.io/system'] } : {}),
        ...(project ? { dependsOn: [`resource:default/${project.name}`] } : {}),
      },
    };
  }

  /** `project`: the Project whose namespace the server is in, if any. */
  toServerEntity(server: ModelServer, project?: ProjectSummary): Entity {
    const { name, namespace, labels = {} } = server.metadata;
    const s = summarizeServer(server);
    const location = `basis:server/${namespace}/${name}`;
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/basis/servers/${namespace}/${name}`,
        title: 'BASIS portal',
      },
    ];
    const grafanaUrl = project?.grafanaUrl ?? this.options.grafanaUrl?.replace(/\{namespace\}/g, namespace);
    if (s.dashboardUid && grafanaUrl) {
      links.push({ url: `${grafanaUrl.replace(/\/$/, '')}/d/${s.dashboardUid}`, title: 'Grafana dashboard' });
    }
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: `${namespace}--${name}.server`.slice(0, 63),
        title: `${name} (${namespace})`,
        description: `Model server (vLLM on KServe): ${s.model} from ${s.uri}, ${s.replicas} replica(s)${s.gpus ? `, ${serverGPUs(s)} GPU(s) in all` : ', CPU only'}${s.prefixCacheAware ? ', prefix-cache-aware routing' : ''}`,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          'backstage.io/kubernetes-namespace': namespace,
          'backstage.io/kubernetes-label-selector': `app.kubernetes.io/name=${name},app.kubernetes.io/part-of=llminferenceservice`,
        },
        tags: ['genai', 'llm', 'vllm', 'self-hosted'],
        links,
      },
      spec: {
        type: 'model-server',
        owner: labels['backstage.io/owner'] ?? this.options.defaultOwner,
        ...(labels['backstage.io/system'] ? { system: labels['backstage.io/system'] } : {}),
        ...(project ? { dependsOn: [`resource:default/${project.name}`] } : {}),
      },
    };
  }

  /** `project`: the Project whose namespace the MCP server is in, if any. */
  toMcpEntity(server: MCPServer, project?: ProjectSummary): Entity {
    const { name, namespace, labels = {} } = server.metadata;
    const s = summarizeMcpServer(server);
    const location = `basis:mcp/${namespace}/${name}`;
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/basis/mcp-servers/${namespace}/${name}`,
        title: 'BASIS portal',
      },
    ];
    const grafanaUrl = project?.grafanaUrl ?? this.options.grafanaUrl?.replace(/\{namespace\}/g, namespace);
    if (s.dashboardUid && grafanaUrl) {
      links.push({ url: `${grafanaUrl.replace(/\/$/, '')}/d/${s.dashboardUid}`, title: 'Grafana dashboard' });
    }
    const database =
      s.databaseKind === 'GenAIStack' ? `${namespace}--${s.database}.stack` : `${namespace}--${s.database}`;
    const dependsOn = [
      ...(project ? [`resource:default/${project.name}`] : []),
      ...(s.database ? [`resource:default/${database.slice(0, 63)}`] : []),
    ];
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: `${namespace}--${name}.mcp`.slice(0, 63),
        title: `${name} (${namespace})`,
        description: `MCP server over ${s.databaseKind} ${s.database}: ${s.tools.join(', ')}; ${s.mode} search, ${s.clients.length} client(s)`,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          [MCP_ANNOTATION]: `${namespace}/${name}`,
          'backstage.io/kubernetes-namespace': namespace,
          'backstage.io/kubernetes-label-selector': `app.kubernetes.io/name=basis-mcp,ai.cndev.nl/mcpserver=${name}`,
        },
        tags: ['genai', 'mcp', 'agents', ...(s.retrieval ? ['rag'] : []), ...(s.memory ? ['memory'] : [])],
        links,
      },
      spec: {
        type: 'mcp-server',
        owner: labels['backstage.io/owner'] ?? this.options.defaultOwner,
        ...(labels['backstage.io/system'] ? { system: labels['backstage.io/system'] } : {}),
        dependsOn,
      },
    };
  }

  /** `project`: the Project whose namespace the cache is in, if any. */
  toCacheEntity(cache: ValkeyCache, project?: ProjectSummary): Entity {
    const { name, namespace, labels = {} } = cache.metadata;
    const s = summarizeCache(cache);
    const location = `basis:cache/${namespace}/${name}`;
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/basis/caches/${namespace}/${name}`,
        title: 'BASIS portal',
      },
    ];
    const grafanaUrl =
      project?.grafanaUrl ?? this.options.grafanaUrl?.replace(/\{namespace\}/g, namespace);
    if (s.dashboardUid && grafanaUrl) {
      links.push({
        url: `${grafanaUrl.replace(/\/$/, '')}/d/${s.dashboardUid}`,
        title: 'Grafana dashboard',
      });
    }
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: `${namespace}--${name}.valkey`.slice(0, 63),
        title: `${name} (${namespace})`,
        description: `${CACHE_MODES[s.mode].displayName} Valkey cache, ${s.shards} shard(s) with ${s.replicas} replica(s), ${cachePods(s)} pods of ${s.memory}`,
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          [CACHE_ANNOTATION]: `${namespace}/${name}`,
          'backstage.io/kubernetes-namespace': namespace,
          'backstage.io/kubernetes-label-selector': `valkey.io/cluster=${name}`,
        },
        tags: ['valkey', 'cache', s.mode],
        links,
      },
      spec: {
        type: 'valkey-cache',
        owner: labels['backstage.io/owner'] ?? this.options.defaultOwner,
        ...(labels['backstage.io/system'] ? { system: labels['backstage.io/system'] } : {}),
        ...(project ? { dependsOn: [`resource:default/${project.name}`] } : {}),
      },
    };
  }
}

export function readCatalogOptions(config: RootConfigService) {
  return {
    defaultOwner: config.getOptionalString('basis.catalog.defaultOwner') ?? 'group:default/guests',
    appBaseUrl: config.getString('app.baseUrl'),
    grafanaUrl: config.getOptionalString('basis.grafanaUrl'),
  };
}

/**
 * Catalog module registering {@link PostgresClusterEntityProvider}.
 *
 * @public
 */
export const catalogModuleBasis = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'basis-catalog',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        k8s: basisKubernetesServiceRef,
        valkey: valkeyServiceRef,
        stacks: stackServiceRef,
        gateways: gatewayServiceRef,
        servers: serverServiceRef,
        mcp: mcpServiceRef,
      },
      async init({ catalog, config, logger, scheduler, k8s, valkey, stacks, gateways, servers, mcp }) {
        const seconds = config.getOptionalNumber('basis.catalog.refreshSeconds') ?? 30;
        catalog.addEntityProvider(
          new PostgresClusterEntityProvider(
            k8s,
            scheduler.createScheduledTaskRunner({
              frequency: { seconds },
              timeout: { seconds: 60 },
            }),
            logger,
            readCatalogOptions(config),
            valkey,
            stacks,
            gateways,
            servers,
            mcp,
          ),
        );
      },
    });
  },
});
