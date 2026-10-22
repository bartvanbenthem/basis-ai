import { createRouteRef, createSubRouteRef } from '@backstage/frontend-plugin-api';

/** /basis -- the cluster list. */
export const rootRouteRef = createRouteRef();

/** /basis/create -- the create form. */
export const createClusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/create',
});

/** /basis/audit -- a project's audit logs (?project=<name>). */
export const auditRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/audit',
});

/** /basis/:namespace/:name -- one cluster. */
export const clusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name',
});

/** /basis/:namespace/:name/edit -- change a running cluster. */
export const editClusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/edit',
});

/** /basis/:namespace/:name/monitoring -- one cluster's Grafana dashboard. */
export const clusterMonitoringRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/monitoring',
});

/** /basis/:namespace/:name/logs -- stdout of the cluster's pods. */
export const clusterLogsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/logs',
});

/** /basis/:namespace/:name/dr -- switch the primary between the sites. */
export const clusterDisasterRecoveryRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/dr',
});

/** /basis/:namespace/:name/backups -- backups, and restoring them into a new cluster. */
export const clusterBackupsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/backups',
});

/** /basis/locations -- the Kubernetes clusters the platform can use. */
export const locationsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations',
});

/** /basis/locations/create -- add a location from a kubeconfig. */
export const createLocationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/create',
});

/** /basis/locations/:name -- one location and its health. */
export const locationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/:name',
});

/** /basis/locations/:name/edit -- change a location's settings or kubeconfig. */
export const editLocationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/:name/edit',
});

/** /basis/buckets -- every bucket on the object store account COSI uses. */
export const bucketsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/buckets',
});

/** /basis/buckets/:name -- one bucket and its folders. */
export const bucketRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/buckets/:name',
});

/** /basis/volumes -- the disks of PostgreSQL instances in every project. */
export const volumesRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/volumes',
});

/** /basis/projects -- the project list. */
export const projectsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects',
});

/** /basis/projects/create -- the create-project form. */
export const createProjectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/create',
});

/** /basis/projects/:name -- one project and its clusters. */
export const projectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/:name',
});

/** /basis/projects/:name/edit -- change a project's settings. */
export const editProjectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/:name/edit',
});

/** /basis/caches -- the Valkey caches. */
export const cachesRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches',
});

/** /basis/caches/create -- the create-cache form (?mode=semantic presets the mode). */
export const createCacheRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches/create',
});

/** /basis/caches/:namespace/:name -- one cache. */
export const cacheRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches/:namespace/:name',
});

/** /basis/caches/:namespace/:name/monitoring -- one cache's Grafana dashboard. */
export const cacheMonitoringRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches/:namespace/:name/monitoring',
});

/** /basis/caches/:namespace/:name/edit -- change a cache's size and settings. */
export const editCacheRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches/:namespace/:name/edit',
});

/** /basis/stacks -- the GenAI stacks. */
export const stacksRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/stacks',
});

/** /basis/stacks/create -- the create-stack form. */
export const createStackRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/stacks/create',
});

/** /basis/stacks/:namespace/:name -- one stack. */
export const stackRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/stacks/:namespace/:name',
});

/** /basis/stacks/:namespace/:name/edit -- change a stack. */
export const editStackRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/stacks/:namespace/:name/edit',
});

/** /basis/gateways -- the model gateways. */
export const gatewaysRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/gateways',
});

/** /basis/gateways/create -- the create-gateway form. */
export const createGatewayRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/gateways/create',
});

/** /basis/gateways/:namespace/:name -- one gateway. */
export const gatewayRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/gateways/:namespace/:name',
});

/** /basis/gateways/:namespace/:name/edit -- change a gateway's models and clients. */
export const editGatewayRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/gateways/:namespace/:name/edit',
});

/** /basis/servers -- the model servers (self-hosted models). */
export const serversRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/servers',
});

/** /basis/servers/create -- the create-server form. */
export const createServerRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/servers/create',
});

/** /basis/servers/:namespace/:name -- one server. */
export const serverRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/servers/:namespace/:name',
});

/** /basis/servers/:namespace/:name/edit -- change a server's model, replicas and GPUs. */
export const editServerRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/servers/:namespace/:name/edit',
});
