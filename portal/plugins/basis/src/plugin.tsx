import {
  ApiBlueprint,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import {
  CACHE_ANNOTATION,
  CLUSTER_ANNOTATION,
  GATEWAY_ANNOTATION,
  STACK_ANNOTATION,
} from '@internal/backstage-plugin-basis-common';
import { basisApiRef, BasisClient } from './api';
import { PostgresIcon } from './components/common';
import {
  auditRouteRef,
  bucketRouteRef,
  bucketsRouteRef,
  cacheMonitoringRouteRef,
  cacheRouteRef,
  cachesRouteRef,
  clusterBackupsRouteRef,
  clusterDisasterRecoveryRouteRef,
  clusterLogsRouteRef,
  clusterMonitoringRouteRef,
  clusterRouteRef,
  createCacheRouteRef,
  createClusterRouteRef,
  createStackRouteRef,
  editStackRouteRef,
  stackRouteRef,
  stacksRouteRef,
  createGatewayRouteRef,
  editGatewayRouteRef,
  gatewayRouteRef,
  gatewaysRouteRef,
  createLocationRouteRef,
  createProjectRouteRef,
  editCacheRouteRef,
  editClusterRouteRef,
  editLocationRouteRef,
  editProjectRouteRef,
  locationRouteRef,
  locationsRouteRef,
  projectRouteRef,
  projectsRouteRef,
  volumesRouteRef,
  rootRouteRef,
} from './routes';

export const basisApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: basisApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: deps => new BasisClient(deps),
    }),
});

/** /basis: list, create and inspect every BASIS API; the sidebar links into it. */
export const basisPage = PageBlueprint.make({
  params: {
    path: '/basis',
    title: 'BASIS',
    icon: <PostgresIcon />,
    routeRef: rootRouteRef,
    noHeader: true,
    loader: () => import('./components/Router').then(m => <m.Router />),
  },
});

/** "PostgreSQL" tab on the catalog Resource entities the basis backend creates. */
export const basisEntityContent = EntityContentBlueprint.make({
  name: 'postgres',
  params: {
    path: 'postgres',
    title: 'PostgreSQL',
    icon: <PostgresIcon />,
    filter: entity => Boolean(entity.metadata.annotations?.[CLUSTER_ANNOTATION]),
    loader: () =>
      import('./components/EntityPostgresContent').then(m => <m.EntityPostgresContent />),
  },
});

/** "Valkey" tab on the catalog Resource entities of ValkeyCaches. */
export const basisCacheEntityContent = EntityContentBlueprint.make({
  name: 'valkey',
  params: {
    path: 'valkey',
    title: 'Valkey',
    icon: <PostgresIcon />,
    filter: entity => Boolean(entity.metadata.annotations?.[CACHE_ANNOTATION]),
    loader: () => import('./components/EntityCacheContent').then(m => <m.EntityCacheContent />),
  },
});

/** "GenAI stack" tab on the catalog Resource entities of GenAIStacks. */
export const basisStackEntityContent = EntityContentBlueprint.make({
  name: 'genai-stack',
  params: {
    path: 'genai-stack',
    title: 'GenAI stack',
    icon: <PostgresIcon />,
    filter: entity => Boolean(entity.metadata.annotations?.[STACK_ANNOTATION]),
    loader: () => import('./components/EntityStackContent').then(m => <m.EntityStackContent />),
  },
});

/** "Model gateway" tab on the catalog Resource entities of ModelGateways. */
export const basisGatewayEntityContent = EntityContentBlueprint.make({
  name: 'model-gateway',
  params: {
    path: 'model-gateway',
    title: 'Model gateway',
    icon: <PostgresIcon />,
    filter: entity => Boolean(entity.metadata.annotations?.[GATEWAY_ANNOTATION]),
    loader: () => import('./components/EntityGatewayContent').then(m => <m.EntityGatewayContent />),
  },
});

export const basisPlugin = createFrontendPlugin({
  pluginId: 'basis',
  info: { packageJson: () => import('../package.json') },
  extensions: [
    basisApi,
    basisPage,
    basisEntityContent,
    basisCacheEntityContent,
    basisStackEntityContent,
    basisGatewayEntityContent,
  ],
  routes: {
    root: rootRouteRef,
    cluster: clusterRouteRef,
    create: createClusterRouteRef,
    audit: auditRouteRef,
    clusterMonitoring: clusterMonitoringRouteRef,
    clusterLogs: clusterLogsRouteRef,
    clusterDisasterRecovery: clusterDisasterRecoveryRouteRef,
    clusterBackups: clusterBackupsRouteRef,
    projects: projectsRouteRef,
    project: projectRouteRef,
    createProject: createProjectRouteRef,
    editCluster: editClusterRouteRef,
    editProject: editProjectRouteRef,
    locations: locationsRouteRef,
    location: locationRouteRef,
    createLocation: createLocationRouteRef,
    editLocation: editLocationRouteRef,
    buckets: bucketsRouteRef,
    bucket: bucketRouteRef,
    volumes: volumesRouteRef,
    caches: cachesRouteRef,
    cache: cacheRouteRef,
    cacheMonitoring: cacheMonitoringRouteRef,
    createCache: createCacheRouteRef,
    editCache: editCacheRouteRef,
    stacks: stacksRouteRef,
    stack: stackRouteRef,
    createStack: createStackRouteRef,
    editStack: editStackRouteRef,
    gateways: gatewaysRouteRef,
    gateway: gatewayRouteRef,
    createGateway: createGatewayRouteRef,
    editGateway: editGatewayRouteRef,
  },
});
