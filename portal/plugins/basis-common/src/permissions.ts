import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Permissions guarding the basis API. With the default allow-all policy every
 * signed-in user can do everything; write a permission policy that matches
 * on these names to restrict who may create or delete databases.
 */
export const basisClusterReadPermission = createPermission({
  name: 'basis.cluster.read',
  attributes: { action: 'read' },
});

export const basisClusterCreatePermission = createPermission({
  name: 'basis.cluster.create',
  attributes: { action: 'create' },
});

export const basisClusterUpdatePermission = createPermission({
  name: 'basis.cluster.update',
  attributes: { action: 'update' },
});

export const basisClusterDeletePermission = createPermission({
  name: 'basis.cluster.delete',
  attributes: { action: 'delete' },
});

/**
 * Read a cluster's app connection URI, password included (also needs
 * basis.cluster.read). Grant it to whoever may connect to the database.
 */
export const basisClusterCredentialsReadPermission = createPermission({
  name: 'basis.cluster.credentials.read',
  attributes: { action: 'read' },
});

/**
 * Create a cluster from another cluster's backups (also needs
 * basis.cluster.create). The new cluster holds a copy of that data, so this
 * is reading it.
 */
export const basisClusterRestorePermission = createPermission({
  name: 'basis.cluster.restore',
  attributes: { action: 'create' },
});

/**
 * Planned move of a geo-replicated cluster's primary to the other site: the
 * primary is demoted first, so no transaction is lost. Also switches a
 * GenAIStack over, which moves its database's primary.
 */
export const basisClusterSwitchoverPermission = createPermission({
  name: 'basis.cluster.switchover',
  attributes: { action: 'update' },
});

/**
 * Promote the other site right away, for when the primary's site is down.
 * Transactions not archived yet are lost: reserve it for on-call or platform
 * admins. Also fails a GenAIStack over.
 */
export const basisClusterFailoverPermission = createPermission({
  name: 'basis.cluster.failover',
  attributes: { action: 'update' },
});

/** List Projects (also what the create-cluster form needs to offer namespaces). */
export const basisProjectReadPermission = createPermission({
  name: 'basis.project.read',
  attributes: { action: 'read' },
});

/**
 * Create a Project: a namespace with its own Prometheus and Grafana. Usually
 * reserved for platform admins or team leads.
 */
export const basisProjectCreatePermission = createPermission({
  name: 'basis.project.create',
  attributes: { action: 'create' },
});

/**
 * Read a Project's audit logs: the Kubernetes events in its namespace and the
 * pgaudit records of its PostgreSQL clusters, which carry SQL statements.
 */
export const basisProjectAuditReadPermission = createPermission({
  name: 'basis.project.audit.read',
  attributes: { action: 'read' },
});

/** Change a Project's owner, access, quota and observability settings. */
export const basisProjectUpdatePermission = createPermission({
  name: 'basis.project.update',
  attributes: { action: 'update' },
});

/**
 * Delete a Project that no longer has PostgreSQL clusters: its namespace,
 * Prometheus and Grafana (and their metrics) on the control plane go with
 * it. The portal turns its deletionProtection off for the delete.
 */
export const basisProjectDeletePermission = createPermission({
  name: 'basis.project.delete',
  attributes: { action: 'delete' },
});

/** List and inspect locations (never their kubeconfig) and run their health checks. */
export const basisLocationReadPermission = createPermission({
  name: 'basis.location.read',
  attributes: { action: 'read' },
});

/**
 * Add a location: hand the platform a kubeconfig for another cluster. Meant
 * for platform admins only.
 */
export const basisLocationCreatePermission = createPermission({
  name: 'basis.location.create',
  attributes: { action: 'create' },
});

/** Change a location's settings or replace its kubeconfig. */
export const basisLocationUpdatePermission = createPermission({
  name: 'basis.location.update',
  attributes: { action: 'update' },
});

/** Remove a location (and its stored kubeconfig). Databases on it are not touched. */
export const basisLocationDeletePermission = createPermission({
  name: 'basis.location.delete',
  attributes: { action: 'delete' },
});

/**
 * List the buckets on the object store account COSI uses (with their size and
 * folders), including those of deleted Projects.
 */
export const basisBucketReadPermission = createPermission({
  name: 'basis.bucket.read',
  attributes: { action: 'read' },
});

/**
 * Delete an orphaned bucket (nothing on the cluster uses it) with everything in
 * it, such as a deleted Project's backups. Can't be undone: platform admins only.
 */
export const basisBucketDeletePermission = createPermission({
  name: 'basis.bucket.delete',
  attributes: { action: 'delete' },
});

/**
 * List the disks (PersistentVolumeClaims and PersistentVolumes) of the
 * PostgreSQL instances in every project and location, including orphaned ones.
 */
export const basisVolumeReadPermission = createPermission({
  name: 'basis.volume.read',
  attributes: { action: 'read' },
});

/**
 * Delete an orphaned disk (its PostgresCluster is gone) together with the
 * storage behind it. Can't be undone: platform admins only.
 */
export const basisVolumeDeletePermission = createPermission({
  name: 'basis.volume.delete',
  attributes: { action: 'delete' },
});

/** List and inspect ValkeyCaches (exact and semantic caches) and their pods. */
export const basisCacheReadPermission = createPermission({
  name: 'basis.cache.read',
  attributes: { action: 'read' },
});

export const basisCacheCreatePermission = createPermission({
  name: 'basis.cache.create',
  attributes: { action: 'create' },
});

export const basisCacheUpdatePermission = createPermission({
  name: 'basis.cache.update',
  attributes: { action: 'update' },
});

/** Delete a cache: its pods and every key in it go. */
export const basisCacheDeletePermission = createPermission({
  name: 'basis.cache.delete',
  attributes: { action: 'delete' },
});

/**
 * Read a cache's connection URI, password included (also needs
 * basis.cache.read). Grant it to whoever may connect to the cache.
 */
export const basisCacheCredentialsReadPermission = createPermission({
  name: 'basis.cache.credentials.read',
  attributes: { action: 'read' },
});

/** List and inspect GenAIStacks (database, caches, gateway and wiring per site). */
export const basisStackReadPermission = createPermission({
  name: 'basis.stack.read',
  attributes: { action: 'read' },
});

export const basisStackCreatePermission = createPermission({
  name: 'basis.stack.create',
  attributes: { action: 'create' },
});

export const basisStackUpdatePermission = createPermission({
  name: 'basis.stack.update',
  attributes: { action: 'update' },
});

/** Delete a stack: its database, caches and gateway go with it. */
export const basisStackDeletePermission = createPermission({
  name: 'basis.stack.delete',
  attributes: { action: 'delete' },
});

/**
 * Read a stack's connection values (database and cache passwords, the
 * gateway key; also needs basis.stack.read).
 */
export const basisStackCredentialsReadPermission = createPermission({
  name: 'basis.stack.credentials.read',
  attributes: { action: 'read' },
});

/** List and inspect ModelGateways (an OpenAI-compatible endpoint to a project's models). */
export const basisGatewayReadPermission = createPermission({
  name: 'basis.gateway.read',
  attributes: { action: 'read' },
});

export const basisGatewayCreatePermission = createPermission({
  name: 'basis.gateway.create',
  attributes: { action: 'create' },
});

/** Change a gateway: its models, and who may call it (clients). */
export const basisGatewayUpdatePermission = createPermission({
  name: 'basis.gateway.update',
  attributes: { action: 'update' },
});

/** Delete a gateway: every client's key stops working. */
export const basisGatewayDeletePermission = createPermission({
  name: 'basis.gateway.delete',
  attributes: { action: 'delete' },
});

/**
 * Read a gateway's client API keys (also needs basis.gateway.read). Grant it
 * to whoever hands keys to apps and agents.
 */
export const basisGatewayCredentialsReadPermission = createPermission({
  name: 'basis.gateway.credentials.read',
  attributes: { action: 'read' },
});

/** List and inspect ModelServers (self-hosted models) and their pods. */
export const basisServerReadPermission = createPermission({
  name: 'basis.server.read',
  attributes: { action: 'read' },
});

/** Create a server: it takes GPUs in the project's location(s). */
export const basisServerCreatePermission = createPermission({
  name: 'basis.server.create',
  attributes: { action: 'create' },
});

/** Change a server: its model, replicas and GPUs. */
export const basisServerUpdatePermission = createPermission({
  name: 'basis.server.update',
  attributes: { action: 'update' },
});

/** Delete a server: the gateways' models on it stop answering. */
export const basisServerDeletePermission = createPermission({
  name: 'basis.server.delete',
  attributes: { action: 'delete' },
});

export const basisPermissions = [
  basisClusterReadPermission,
  basisClusterCreatePermission,
  basisClusterUpdatePermission,
  basisClusterDeletePermission,
  basisClusterCredentialsReadPermission,
  basisClusterRestorePermission,
  basisClusterSwitchoverPermission,
  basisClusterFailoverPermission,
  basisProjectReadPermission,
  basisProjectAuditReadPermission,
  basisProjectCreatePermission,
  basisProjectUpdatePermission,
  basisProjectDeletePermission,
  basisLocationReadPermission,
  basisLocationCreatePermission,
  basisLocationUpdatePermission,
  basisLocationDeletePermission,
  basisBucketReadPermission,
  basisBucketDeletePermission,
  basisVolumeReadPermission,
  basisVolumeDeletePermission,
  basisCacheReadPermission,
  basisCacheCreatePermission,
  basisCacheUpdatePermission,
  basisCacheDeletePermission,
  basisCacheCredentialsReadPermission,
  basisStackReadPermission,
  basisStackCreatePermission,
  basisStackUpdatePermission,
  basisStackDeletePermission,
  basisStackCredentialsReadPermission,
  basisGatewayReadPermission,
  basisGatewayCreatePermission,
  basisGatewayUpdatePermission,
  basisGatewayDeletePermission,
  basisGatewayCredentialsReadPermission,
  basisServerReadPermission,
  basisServerCreatePermission,
  basisServerUpdatePermission,
  basisServerDeletePermission,
];
