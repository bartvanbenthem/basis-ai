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
  CnpgKubernetesService,
  cnpgKubernetesServiceRef,
} from '../service/CnpgKubernetesService';
import { ValkeyService, valkeyServiceRef } from '../service/ValkeyService';
import {
  CACHE_ANNOTATION,
  CACHE_MODES,
  cachePods,
  CNPG_ANNOTATION,
  PostgresCluster,
  Project,
  PROJECT_ANNOTATION,
  ProjectSummary,
  summarize,
  summarizeCache,
  summarizeProject,
  ValkeyCache,
} from '@internal/backstage-plugin-cnpg-common';

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
 *
 * Project names can't contain "--" (enforced by the XRD), and cluster and
 * cache names no ".", so none of them collide.
 */
export class PostgresClusterEntityProvider implements EntityProvider {
  #connection?: EntityProviderConnection;

  constructor(
    private readonly k8s: CnpgKubernetesService,
    private readonly taskRunner: SchedulerServiceTaskRunner,
    private readonly logger: LoggerService,
    private readonly options: { defaultOwner: string; appBaseUrl: string; grafanaUrl?: string },
    private readonly valkey?: Pick<ValkeyService, 'list'>,
  ) {}

  getProviderName() {
    return 'cnpg-postgresclusters';
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
    const [clusters, projects, caches] = await Promise.all([
      this.k8s.list(),
      this.k8s.listProjects(),
      this.valkey?.list() ?? Promise.resolve([]),
    ]);
    const byName = new Map(projects.map(p => [p.metadata.name, summarizeProject(p)]));
    const entities = [
      ...projects.map(p => this.toProjectEntity(p)),
      ...clusters.map(c => this.toEntity(c, byName.get(c.metadata.namespace))),
      ...caches.map(c => this.toCacheEntity(c, byName.get(c.metadata.namespace))),
    ];
    await this.#connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({ entity, locationKey: this.getProviderName() })),
    });
    this.logger.debug(
      `Synced ${projects.length} Projects, ${clusters.length} PostgresClusters and ${caches.length} ValkeyCaches into the catalog`,
    );
  }

  toProjectEntity(project: Project): Entity {
    const s = summarizeProject(project);
    const location = `cnpg:project/${s.name}`;
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/cnpg/projects/${s.name}`,
        title: 'CNPG portal',
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
    const location = `cnpg:${namespace}/${name}`;
    const dashboardUid = cluster.status?.monitoring?.dashboardUid;
    // Entity links must be absolute URLs.
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/cnpg/${namespace}/${name}`,
        title: 'CNPG portal',
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
          [CNPG_ANNOTATION]: `${namespace}/${name}`,
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
  /** `project`: the Project whose namespace the cache is in, if any. */
  toCacheEntity(cache: ValkeyCache, project?: ProjectSummary): Entity {
    const { name, namespace, labels = {} } = cache.metadata;
    const s = summarizeCache(cache);
    const location = `cnpg:cache/${namespace}/${name}`;
    const links = [
      {
        url: `${this.options.appBaseUrl.replace(/\/$/, '')}/cnpg/caches/${namespace}/${name}`,
        title: 'CNPG portal',
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
    defaultOwner: config.getOptionalString('cnpg.catalog.defaultOwner') ?? 'group:default/guests',
    appBaseUrl: config.getString('app.baseUrl'),
    grafanaUrl: config.getOptionalString('cnpg.grafanaUrl'),
  };
}

/**
 * Catalog module registering {@link PostgresClusterEntityProvider}.
 *
 * @public
 */
export const catalogModuleCnpg = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'cnpg-postgresclusters',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        k8s: cnpgKubernetesServiceRef,
        valkey: valkeyServiceRef,
      },
      async init({ catalog, config, logger, scheduler, k8s, valkey }) {
        const seconds = config.getOptionalNumber('cnpg.catalog.refreshSeconds') ?? 30;
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
          ),
        );
      },
    });
  },
});
