import type { BackupServer, PostgresCluster } from './types';

/**
 * Restoring is creating a new PostgresCluster with spec.restore: it
 * recovers from another cluster's backup folder (up to a point in time, or
 * the latest state) and archives to a folder of its own. The source is only
 * read, so a restore never touches the cluster it comes from.
 */

/** An object store of a cluster's own (backup.destinationPath and friends). */
export interface RestoreStore {
  destinationPath: string;
  endpointURL?: string;
  endpointCA?: { secretName: string; key?: string };
  s3Credentials: {
    secretName: string;
    accessKeyIdKey?: string;
    secretAccessKeyKey?: string;
    regionKey?: string;
  };
}

/** A backup folder a new cluster can be restored from. */
export interface RestoreSource {
  /** Barman server name: the folder in the object store. */
  serverName: string;
  /** The cluster that archives (or archived) to it. */
  cluster?: string;
  /** Unset: the Project's backup bucket. */
  store?: RestoreStore;
  postgresVersion?: number;
  database?: { name?: string; owner?: string };
  /** Oldest moment it can be restored to; unset until its first base backup is reported. */
  firstRecoverabilityPoint?: string;
  lastSuccessfulBackup?: string;
}

/** Where `cluster`'s backups can be restored from: the folder its primary archives to. */
export function clusterRestoreSource(cluster: PostgresCluster): RestoreSource | { error: string } {
  const { metadata, spec, status } = cluster;
  const backup = spec.backup ?? {};
  if (!backup.enabled) return { error: `${metadata.name} has no backups to restore from` };
  const serverName = status?.backup?.serverName;
  if (!serverName) return { error: `${metadata.name} hasn't reported its backup folder yet` };
  return {
    serverName,
    cluster: metadata.name,
    store: backup.destinationPath
      ? {
          destinationPath: backup.destinationPath,
          ...(backup.endpointURL ? { endpointURL: backup.endpointURL } : {}),
          ...(backup.endpointCA ? { endpointCA: backup.endpointCA } : {}),
          s3Credentials: backup.s3Credentials,
        }
      : undefined,
    postgresVersion: spec.postgresVersion,
    database: { name: spec.database?.name, owner: spec.database?.owner },
    firstRecoverabilityPoint: status?.backup?.firstRecoverabilityPoint || undefined,
    lastSuccessfulBackup: status?.backup?.lastSuccessfulBackup || undefined,
  };
}

/** A folder from the Project's inventory of its bucket. */
export function serverRestoreSource(server: BackupServer): RestoreSource {
  return {
    serverName: server.serverName,
    cluster: server.cluster || undefined,
    postgresVersion: server.postgresVersion || undefined,
    database: { name: server.database || undefined, owner: server.owner || undefined },
    firstRecoverabilityPoint: server.firstRecoverabilityPoint || undefined,
    lastSuccessfulBackup: server.lastSuccessfulBackup || undefined,
  };
}

// What the XRD's format: date-time accepts.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Why `source` can't be restored up to `targetTime` (unset: the latest state), if it can't. */
export function targetTimeError(
  source: RestoreSource,
  targetTime: string | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!targetTime) return undefined;
  if (!RFC3339.test(targetTime) || Number.isNaN(Date.parse(targetTime))) {
    return 'the target time must be RFC 3339, e.g. 2026-10-08T09:30:00Z';
  }
  if (Date.parse(targetTime) > now.getTime()) return 'the target time is in the future';
  const first = source.firstRecoverabilityPoint;
  if (first && Date.parse(targetTime) < Date.parse(first)) {
    return `the target time is before the oldest recoverable moment of ${source.serverName} (${first})`;
  }
  return undefined;
}

/**
 * The spec of a new cluster restored from `source`. `base` is the spec of
 * the cluster the folder belongs to while it still exists: the copy gets the
 * same size, settings and external service, but no replica cluster of its own
 * until it's turned on (a restore is often a copy to look at). Without one it
 * gets the defaults, with backups in the Project's bucket.
 */
export function restoreSpec(
  source: RestoreSource,
  options: { targetTime?: string; storageSize?: string; base?: Record<string, any> } = {},
): Record<string, unknown> {
  const { restore: _r, geoReplication: _g, ...base } = options.base ?? {};
  let spec: Record<string, any> = base;
  if (!options.base) spec = source.store ? {} : { backup: { enabled: true } };
  if (source.postgresVersion) spec.postgresVersion = source.postgresVersion;
  const database = Object.fromEntries(
    Object.entries(source.database ?? {}).filter(([, v]) => Boolean(v)),
  );
  if (Object.keys(database).length) spec.database = { ...spec.database, ...database };
  if (options.storageSize) spec.storage = { ...spec.storage, size: options.storageSize };
  spec.restore = {
    source: { serverName: source.serverName, ...source.store },
    ...(options.targetTime ? { targetTime: options.targetTime } : {}),
  };
  return spec;
}
