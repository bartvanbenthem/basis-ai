import {
  clusterRestoreSource,
  restoreSpec,
  serverRestoreSource,
  targetTimeError,
} from './restore';
import type { PostgresCluster } from './types';

const cluster = (
  spec: Record<string, any>,
  status: PostgresCluster['status'] = {},
): PostgresCluster => ({
  apiVersion: 'postgres.cndev.nl/v1alpha1',
  kind: 'PostgresCluster',
  metadata: { name: 'orders-db', namespace: 'demo' },
  spec,
  status,
});

const ordersDb = cluster(
  {
    postgresVersion: 16,
    instances: 3,
    storage: { size: '50Gi' },
    database: { name: 'orders', owner: 'orders' },
    backup: { enabled: true, retentionPolicy: '14d' },
    geoReplication: { enabled: true, primarySite: 'recovery' },
    expose: { type: 'LoadBalancer' },
    pooler: { enabled: true },
  },
  {
    backup: {
      serverName: 'orders-db',
      firstRecoverabilityPoint: '2026-10-01T02:00:00Z',
      lastSuccessfulBackup: '2026-10-08T02:00:00Z',
    },
  },
);

describe('restore', () => {
  it('restores a cluster from the folder its primary archives to', () => {
    const source = clusterRestoreSource(ordersDb);
    expect(source).toEqual({
      serverName: 'orders-db',
      cluster: 'orders-db',
      store: undefined,
      postgresVersion: 16,
      database: { name: 'orders', owner: 'orders' },
      firstRecoverabilityPoint: '2026-10-01T02:00:00Z',
      lastSuccessfulBackup: '2026-10-08T02:00:00Z',
    });
  });

  it('needs backups and a reported folder', () => {
    expect(clusterRestoreSource(cluster({ backup: { enabled: false } }))).toEqual({
      error: 'orders-db has no backups to restore from',
    });
    expect(clusterRestoreSource(cluster({ backup: { enabled: true } }))).toEqual({
      error: "orders-db hasn't reported its backup folder yet",
    });
  });

  it('keeps the store of a cluster with a destination of its own', () => {
    const store = {
      destinationPath: 's3://own/pg',
      endpointURL: 'https://minio.example.com',
      s3Credentials: { secretName: 'orders-s3' },
    };
    const source = clusterRestoreSource(
      cluster({ backup: { enabled: true, schedule: '0 0 3 * * *', ...store } }, { backup: { serverName: 'orders-db' } }),
    );
    expect(source).toMatchObject({ store });
    expect(restoreSpec(source as any).restore).toEqual({
      source: { serverName: 'orders-db', ...store },
    });
  });

  it('copies the source cluster and its external service, without a replica cluster', () => {
    const source = clusterRestoreSource(ordersDb) as any;
    expect(
      restoreSpec(source, { base: ordersDb.spec, targetTime: '2026-10-08T09:30:00Z' }),
    ).toEqual({
      postgresVersion: 16,
      instances: 3,
      storage: { size: '50Gi' },
      database: { name: 'orders', owner: 'orders' },
      backup: { enabled: true, retentionPolicy: '14d' },
      expose: { type: 'LoadBalancer' },
      pooler: { enabled: true },
      restore: { source: { serverName: 'orders-db' }, targetTime: '2026-10-08T09:30:00Z' },
    });
    // The source's spec itself is left alone.
    expect(ordersDb.spec.geoReplication).toBeDefined();
  });

  it("restores a deleted cluster's folder with defaults and backups in the Project's bucket", () => {
    const source = serverRestoreSource({
      serverName: 'old-db-3f2a9c1e',
      cluster: 'old-db',
      active: false,
      postgresVersion: 17,
      database: 'app',
      owner: 'app',
      firstRecoverabilityPoint: '2026-09-01T02:00:00Z',
    });
    expect(restoreSpec(source, { storageSize: '20Gi' })).toEqual({
      backup: { enabled: true },
      postgresVersion: 17,
      database: { name: 'app', owner: 'app' },
      storage: { size: '20Gi' },
      restore: { source: { serverName: 'old-db-3f2a9c1e' } },
    });
  });

  it('checks the target time against the recoverable window', () => {
    const source = clusterRestoreSource(ordersDb) as any;
    const now = new Date('2026-10-08T12:00:00Z');
    expect(targetTimeError(source, undefined, now)).toBeUndefined();
    expect(targetTimeError(source, '2026-10-08T09:30:00Z', now)).toBeUndefined();
    expect(targetTimeError(source, '2026-10-08T11:00:00+02:00', now)).toBeUndefined();
    expect(targetTimeError(source, '2026-10-08 09:30', now)).toMatch(/RFC 3339/);
    expect(targetTimeError(source, '2026-10-09T00:00:00Z', now)).toMatch(/in the future/);
    expect(targetTimeError(source, '2026-09-30T00:00:00Z', now)).toMatch(
      /before the oldest recoverable moment of orders-db \(2026-10-01T02:00:00Z\)/,
    );
  });
});
