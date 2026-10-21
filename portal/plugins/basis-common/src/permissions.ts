import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Permissions guarding the cnpg API. With the default allow-all policy every
 * signed-in user can do everything; write a permission policy that matches
 * on these names to restrict who may create or delete databases.
 */
export const cnpgClusterReadPermission = createPermission({
  name: 'cnpg.cluster.read',
  attributes: { action: 'read' },
});

export const cnpgClusterCreatePermission = createPermission({
  name: 'cnpg.cluster.create',
  attributes: { action: 'create' },
});

export const cnpgClusterUpdatePermission = createPermission({
  name: 'cnpg.cluster.update',
  attributes: { action: 'update' },
});

export const cnpgClusterDeletePermission = createPermission({
  name: 'cnpg.cluster.delete',
  attributes: { action: 'delete' },
});

/**
 * Read a cluster's app connection URI, password included (also needs
 * cnpg.cluster.read). Grant it to whoever may connect to the database.
 */
export const cnpgClusterCredentialsReadPermission = createPermission({
  name: 'cnpg.cluster.credentials.read',
  attributes: { action: 'read' },
});

/**
 * Create a cluster from another cluster's backups (also needs
 * cnpg.cluster.create). The new cluster holds a copy of that data, so this
 * is reading it.
 */
export const cnpgClusterRestorePermission = createPermission({
  name: 'cnpg.cluster.restore',
  attributes: { action: 'create' },
});

/**
 * Planned move of a geo-replicated cluster's primary to the other site: the
 * primary is demoted first, so no transaction is lost.
 */
export const cnpgClusterSwitchoverPermission = createPermission({
  name: 'cnpg.cluster.switchover',
  attributes: { action: 'update' },
});

/**
 * Promote the other site right away, for when the primary's site is down.
 * Transactions not archived yet are lost: reserve it for on-call or platform
 * admins.
 */
export const cnpgClusterFailoverPermission = createPermission({
  name: 'cnpg.cluster.failover',
  attributes: { action: 'update' },
});

/** List Projects (also what the create-cluster form needs to offer namespaces). */
export const cnpgProjectReadPermission = createPermission({
  name: 'cnpg.project.read',
  attributes: { action: 'read' },
});

/**
 * Create a Project: a namespace with its own Prometheus and Grafana. Usually
 * reserved for platform admins or team leads.
 */
export const cnpgProjectCreatePermission = createPermission({
  name: 'cnpg.project.create',
  attributes: { action: 'create' },
});

/**
 * Read a Project's audit logs: the Kubernetes events in its namespace and the
 * pgaudit records of its PostgreSQL clusters, which carry SQL statements.
 */
export const cnpgProjectAuditReadPermission = createPermission({
  name: 'cnpg.project.audit.read',
  attributes: { action: 'read' },
});

/** Change a Project's owner, access, quota and observability settings. */
export const cnpgProjectUpdatePermission = createPermission({
  name: 'cnpg.project.update',
  attributes: { action: 'update' },
});

/**
 * Delete a Project that no longer has PostgreSQL clusters: its namespace,
 * Prometheus and Grafana (and their metrics) on the control plane go with
 * it. The portal turns its deletionProtection off for the delete.
 */
export const cnpgProjectDeletePermission = createPermission({
  name: 'cnpg.project.delete',
  attributes: { action: 'delete' },
});

/** List and inspect locations (never their kubeconfig) and run their health checks. */
export const cnpgLocationReadPermission = createPermission({
  name: 'cnpg.location.read',
  attributes: { action: 'read' },
});

/**
 * Add a location: hand the platform a kubeconfig for another cluster. Meant
 * for platform admins only.
 */
export const cnpgLocationCreatePermission = createPermission({
  name: 'cnpg.location.create',
  attributes: { action: 'create' },
});

/** Change a location's settings or replace its kubeconfig. */
export const cnpgLocationUpdatePermission = createPermission({
  name: 'cnpg.location.update',
  attributes: { action: 'update' },
});

/** Remove a location (and its stored kubeconfig). Databases on it are not touched. */
export const cnpgLocationDeletePermission = createPermission({
  name: 'cnpg.location.delete',
  attributes: { action: 'delete' },
});

/**
 * List the buckets on the object store account COSI uses (with their size and
 * folders), including those of deleted Projects.
 */
export const cnpgBucketReadPermission = createPermission({
  name: 'cnpg.bucket.read',
  attributes: { action: 'read' },
});

/**
 * Delete an orphaned bucket (nothing on the cluster uses it) with everything in
 * it, such as a deleted Project's backups. Can't be undone: platform admins only.
 */
export const cnpgBucketDeletePermission = createPermission({
  name: 'cnpg.bucket.delete',
  attributes: { action: 'delete' },
});

/**
 * List the disks (PersistentVolumeClaims and PersistentVolumes) of the
 * PostgreSQL instances in every project and location, including orphaned ones.
 */
export const cnpgVolumeReadPermission = createPermission({
  name: 'cnpg.volume.read',
  attributes: { action: 'read' },
});

/**
 * Delete an orphaned disk (its PostgresCluster is gone) together with the
 * storage behind it. Can't be undone: platform admins only.
 */
export const cnpgVolumeDeletePermission = createPermission({
  name: 'cnpg.volume.delete',
  attributes: { action: 'delete' },
});

/** List and inspect ValkeyCaches (exact and semantic caches) and their pods. */
export const cnpgCacheReadPermission = createPermission({
  name: 'cnpg.cache.read',
  attributes: { action: 'read' },
});

export const cnpgCacheCreatePermission = createPermission({
  name: 'cnpg.cache.create',
  attributes: { action: 'create' },
});

export const cnpgCacheUpdatePermission = createPermission({
  name: 'cnpg.cache.update',
  attributes: { action: 'update' },
});

/** Delete a cache: its pods and every key in it go. */
export const cnpgCacheDeletePermission = createPermission({
  name: 'cnpg.cache.delete',
  attributes: { action: 'delete' },
});

/**
 * Read a cache's connection URI, password included (also needs
 * cnpg.cache.read). Grant it to whoever may connect to the cache.
 */
export const cnpgCacheCredentialsReadPermission = createPermission({
  name: 'cnpg.cache.credentials.read',
  attributes: { action: 'read' },
});

export const cnpgPermissions = [
  cnpgClusterReadPermission,
  cnpgClusterCreatePermission,
  cnpgClusterUpdatePermission,
  cnpgClusterDeletePermission,
  cnpgClusterCredentialsReadPermission,
  cnpgClusterRestorePermission,
  cnpgClusterSwitchoverPermission,
  cnpgClusterFailoverPermission,
  cnpgProjectReadPermission,
  cnpgProjectAuditReadPermission,
  cnpgProjectCreatePermission,
  cnpgProjectUpdatePermission,
  cnpgProjectDeletePermission,
  cnpgLocationReadPermission,
  cnpgLocationCreatePermission,
  cnpgLocationUpdatePermission,
  cnpgLocationDeletePermission,
  cnpgBucketReadPermission,
  cnpgBucketDeletePermission,
  cnpgVolumeReadPermission,
  cnpgVolumeDeletePermission,
  cnpgCacheReadPermission,
  cnpgCacheCreatePermission,
  cnpgCacheUpdatePermission,
  cnpgCacheDeletePermission,
  cnpgCacheCredentialsReadPermission,
];
