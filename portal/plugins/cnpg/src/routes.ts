import { createRouteRef, createSubRouteRef } from '@backstage/frontend-plugin-api';

/** /cnpg -- the cluster list. */
export const rootRouteRef = createRouteRef();

/** /cnpg/create -- the create form. */
export const createClusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/create',
});

/** /cnpg/audit -- a project's audit logs (?project=<name>). */
export const auditRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/audit',
});

/** /cnpg/:namespace/:name -- one cluster. */
export const clusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name',
});

/** /cnpg/:namespace/:name/edit -- change a running cluster. */
export const editClusterRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/edit',
});

/** /cnpg/:namespace/:name/monitoring -- one cluster's Grafana dashboard. */
export const clusterMonitoringRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/monitoring',
});

/** /cnpg/:namespace/:name/logs -- stdout of the cluster's pods. */
export const clusterLogsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/logs',
});

/** /cnpg/:namespace/:name/dr -- switch the primary between the sites. */
export const clusterDisasterRecoveryRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/dr',
});

/** /cnpg/:namespace/:name/backups -- backups, and restoring them into a new cluster. */
export const clusterBackupsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/:namespace/:name/backups',
});

/** /cnpg/locations -- the Kubernetes clusters the platform can use. */
export const locationsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations',
});

/** /cnpg/locations/create -- add a location from a kubeconfig. */
export const createLocationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/create',
});

/** /cnpg/locations/:name -- one location and its health. */
export const locationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/:name',
});

/** /cnpg/locations/:name/edit -- change a location's settings or kubeconfig. */
export const editLocationRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/locations/:name/edit',
});

/** /cnpg/buckets -- every bucket on the object store account COSI uses. */
export const bucketsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/buckets',
});

/** /cnpg/buckets/:name -- one bucket and its folders. */
export const bucketRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/buckets/:name',
});

/** /cnpg/volumes -- the disks of PostgreSQL instances in every project. */
export const volumesRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/volumes',
});

/** /cnpg/projects -- the project list. */
export const projectsRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects',
});

/** /cnpg/projects/create -- the create-project form. */
export const createProjectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/create',
});

/** /cnpg/projects/:name -- one project and its clusters. */
export const projectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/:name',
});

/** /cnpg/projects/:name/edit -- change a project's settings. */
export const editProjectRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/projects/:name/edit',
});

/** /cnpg/caches -- the Valkey caches. */
export const cachesRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches',
});

/** /cnpg/caches/create -- the create-cache form (?mode=semantic presets the mode). */
export const createCacheRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches/create',
});

/** /cnpg/caches/:namespace/:name -- one cache. */
export const cacheRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches/:namespace/:name',
});

/** /cnpg/caches/:namespace/:name/monitoring -- one cache's Grafana dashboard. */
export const cacheMonitoringRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches/:namespace/:name/monitoring',
});

/** /cnpg/caches/:namespace/:name/edit -- change a cache's size and settings. */
export const editCacheRouteRef = createSubRouteRef({
  parent: rootRouteRef,
  path: '/caches/:namespace/:name/edit',
});
