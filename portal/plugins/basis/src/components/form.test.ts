import { parseExtensions, parseSizes, PostgresCluster } from '@internal/backstage-plugin-basis-common';
import {
  defaultForm,
  fromCluster,
  mergePatch,
  selectPostgresVersion,
  selectProfile,
  selectSize,
  toEditPatch,
  toSpec,
  validate,
  validateEdit,
} from './form';

describe('create form', () => {
  it('maps the defaults onto a minimal spec', () => {
    const spec = toSpec({ ...defaultForm('demo'), name: 'orders-db' });
    expect(spec).toEqual({
      postgresVersion: 17,
      instances: 3,
      storage: { size: '10Gi' },
      resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { memory: '1Gi' } },
      database: { name: 'app', owner: 'app' },
      highAvailability: { podAntiAffinityType: 'preferred', zoneSpread: true, synchronousReplicas: 0 },
      monitoring: { enabled: true, grafanaDashboard: { enabled: true } },
    });
  });

  it('is internal by default and exposes only with client CIDRs', () => {
    const internal = toSpec({ ...defaultForm('demo'), name: 'orders-db' });
    expect(internal.expose).toBeUndefined();
    const f = { ...defaultForm('demo'), name: 'orders-db', exposeEnabled: true };
    expect(validate(f).exposeSourceRanges).toMatch(/CIDRs/);
    expect(validate({ ...f, exposeSourceRanges: '10.0.0.0/8, nope' }).exposeSourceRanges).toMatch(/CIDRs like/);
    const exposed = { ...f, exposeSourceRanges: '10.0.0.0/8,\n203.0.113.10/32' };
    expect(validate(exposed).exposeSourceRanges).toBeUndefined();
    expect(toSpec(exposed).expose).toEqual({ enabled: true, loadBalancerSourceRanges: ['10.0.0.0/8', '203.0.113.10/32'] });
  });

  it('round-trips expose, and an edit can turn it off', () => {
    const cluster: PostgresCluster = {
      apiVersion: 'postgres.cndev.nl/v1alpha1',
      kind: 'PostgresCluster',
      metadata: { name: 'orders-db', namespace: 'demo' },
      spec: { expose: { enabled: true, loadBalancerSourceRanges: ['10.0.0.0/8'] } },
    };
    const original = fromCluster(cluster);
    expect(original).toMatchObject({ exposeEnabled: true, exposeSourceRanges: '10.0.0.0/8' });
    expect(toEditPatch(original, { ...original, exposeEnabled: false })).toEqual({ expose: { enabled: false } });
  });

  it('adds pooler, backup and WAL sections only when enabled', () => {
    const spec = toSpec({
      ...defaultForm('demo'),
      name: 'x',
      storageClass: 'premium',
      walEnabled: true,
      poolerEnabled: true,
      backupEnabled: true,
      backupDestinationPath: 's3://b/p',
      backupSecretName: 's3-creds',
      synchronousReplicas: 1,
    }) as any;
    expect(spec.walStorage).toEqual({ size: '5Gi', storageClass: 'premium' });
    expect(spec.pooler).toEqual({ enabled: true, instances: 2, poolMode: 'transaction', readOnly: false });
    expect(spec.backup).toMatchObject({ destinationPath: 's3://b/p', s3Credentials: { secretName: 's3-creds' } });
    expect(spec.backup.endpointURL).toBeUndefined();
    expect(spec.highAvailability.synchronousDataDurability).toBe('preferred');
  });

  it('flags invalid input', () => {
    const errors = validate({
      ...defaultForm(''),
      name: 'Orders_DB',
      instances: 2,
      synchronousReplicas: 2,
      backupEnabled: true,
      backupSchedule: '0 2 * * *',
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['backupDestinationPath', 'backupSchedule', 'backupSecretName', 'name', 'namespace', 'synchronousReplicas'].sort(),
    );
  });

  it('accepts a valid form', () => {
    expect(validate({ ...defaultForm('demo'), name: 'orders-db' })).toEqual({});
  });
});

/** As the API server returns it: XRD defaults filled in, plus a field the form doesn't know. */
const live: PostgresCluster = {
  apiVersion: 'postgres.cndev.nl/v1alpha1',
  kind: 'PostgresCluster',
  metadata: { name: 'orders-db', namespace: 'demo', labels: { 'backstage.io/owner': 'team-orders' } },
  spec: {
    postgresVersion: 17,
    instances: 3,
    storage: { size: '20Gi', storageClass: 'premium' },
    walStorage: { size: '5Gi', storageClass: 'premium' },
    resources: { requests: { cpu: '1', memory: '2Gi' }, limits: { memory: '2Gi' } },
    database: { name: 'orders', owner: 'orders' },
    highAvailability: { podAntiAffinityType: 'preferred', zoneSpread: true, synchronousReplicas: 1, synchronousDataDurability: 'required' },
    pooler: { enabled: true, instances: 2, poolMode: 'transaction', readOnly: false, maxClientConn: 500 },
    backup: { enabled: false, retentionPolicy: '30d', schedule: '0 0 2 * * *' },
    monitoring: { enabled: true, grafanaDashboard: { enabled: true } },
  },
};

describe('edit form', () => {
  const original = fromCluster(live);

  it('reads an existing cluster into the form', () => {
    expect(original).toMatchObject({
      name: 'orders-db',
      namespace: 'demo',
      owner: 'team-orders',
      storageSize: '20Gi',
      storageClass: 'premium',
      walEnabled: true,
      cpu: '1',
      memory: '2Gi',
      databaseName: 'orders',
      synchronousReplicas: 1,
      synchronousDataDurability: 'required',
      poolerEnabled: true,
      backupEnabled: false,
    });
  });

  it('sends nothing when nothing changed', () => {
    expect(toEditPatch(original, original)).toEqual({});
  });

  it('sends only the changed fields', () => {
    expect(
      toEditPatch(original, { ...original, instances: 5, storageSize: '50Gi', walSize: '10Gi' }),
    ).toEqual({ instances: 5, storage: { size: '50Gi' }, walStorage: { size: '10Gi' } });
  });

  it('turns the pooler off without dropping its settings', () => {
    expect(toEditPatch(original, { ...original, poolerEnabled: false })).toEqual({
      pooler: { enabled: false },
    });
  });

  it('enables backups', () => {
    const patch = toEditPatch(original, {
      ...original,
      backupEnabled: true,
      backupDestinationPath: 's3://bucket/pg',
      backupSecretName: 's3-creds',
    });
    expect(patch).toEqual({
      backup: {
        enabled: true,
        destinationPath: 's3://bucket/pg',
        s3Credentials: { secretName: 's3-creds' },
      },
    });
    // Off again: only the switch flips, the destination stays for next time.
    const enabled = { ...original, backupEnabled: true, backupDestinationPath: 's3://b/p', backupSecretName: 's' };
    expect(toEditPatch(enabled, { ...enabled, backupEnabled: false })).toEqual({ backup: { enabled: false } });
  });

  it('refuses to shrink volumes', () => {
    const errors = validateEdit(original, { ...original, storageSize: '10Gi', walSize: '1Gi' });
    expect(errors.storageSize).toMatch(/not shrink/);
    expect(errors.walSize).toMatch(/not shrink/);
    expect(validateEdit(original, { ...original, storageSize: '1Ti' })).toEqual({});
  });
});

const sizes = parseSizes({
  sizes: [
    { name: 'xs', resources: { requests: { cpu: '500m', memory: '1Gi' } }, storage: { size: '10Gi' } },
    { name: 'm', resources: { requests: { cpu: '2', memory: '8Gi' } }, storage: { size: '50Gi', walSize: '10Gi' } },
  ],
});

describe('sizes', () => {
  it('sends the size instead of resources', () => {
    const spec = toSpec({ ...defaultForm('demo'), name: 'orders-db', size: 'm' });
    expect(spec.size).toBe('m');
    expect(spec.resources).toBeUndefined();
  });

  it("suggests a new cluster's volumes, never an existing one's", () => {
    const f = { ...defaultForm('demo'), name: 'orders-db' };
    expect(selectSize(f, 'm', sizes, { suggestVolumes: true })).toMatchObject({
      size: 'm',
      storageSize: '50Gi',
      walEnabled: true,
      walSize: '10Gi',
    });
    expect(selectSize(f, 'm', sizes)).toMatchObject({ size: 'm', storageSize: '10Gi', walEnabled: false });
  });

  it("starts custom resources from the size's", () => {
    const sized = selectSize({ ...defaultForm('demo'), name: 'x' }, 'm', sizes);
    expect(selectSize(sized, '', sizes)).toMatchObject({ size: '', cpu: '2', memory: '8Gi' });
  });

  it('validates custom resources only', () => {
    const f = { ...defaultForm('demo'), name: 'orders-db', cpu: 'two', memory: '8GB' };
    expect(Object.keys(validate(f)).sort()).toEqual(['cpu', 'memory']);
    expect(validate({ ...f, size: 'm' })).toEqual({});
  });

  it('moves a cluster between custom resources and a size', () => {
    const original = fromCluster(live);
    expect(toEditPatch(original, { ...original, size: 'm' })).toEqual({ size: 'm', resources: null });
    const sized = fromCluster({
      ...live,
      spec: { ...live.spec, resources: undefined, size: 'm' },
      status: { sizing: { size: 'm', resources: { requests: { cpu: '2', memory: '8Gi' } } } },
    });
    expect(sized).toMatchObject({ size: 'm', cpu: '2', memory: '8Gi' });
    expect(toEditPatch(sized, { ...sized, size: 'xs' })).toEqual({ size: 'xs' });
    expect(toEditPatch(sized, { ...sized, size: '', memory: '16Gi' })).toEqual({
      size: null,
      resources: { requests: { cpu: '2', memory: '16Gi' }, limits: { memory: '16Gi' } },
    });
  });
});

describe('mergePatch', () => {
  it('nulls removed keys and replaces arrays whole', () => {
    expect(mergePatch({ a: 1, b: { c: 2 }, l: [1] }, { a: 1, l: [1, 2] })).toEqual({ b: null, l: [1, 2] });
    expect(mergePatch({ a: [1] }, { a: [1] })).toBeUndefined();
  });
});

describe('locations', () => {
  const base = {
    ...defaultForm('demo'),
    name: 'orders-db',
    backupEnabled: true,
    backupDestinationPath: 's3://b/p',
    backupSecretName: 's3',
  };

  it('leaves geo replication out until it is switched on', () => {
    expect(toSpec(base)).not.toHaveProperty('geoReplication');
    expect(toSpec(base)).not.toHaveProperty('location');
    expect((toSpec({ ...base, geoReplication: true }) as any).geoReplication).toEqual({ enabled: true });
    expect((toSpec({ ...base, geoReplication: true, geoInstances: 2 }) as any).geoReplication).toEqual({
      enabled: true,
      instances: 2,
    });
  });

  it('needs backups for geo replication, and geo replication for a recovery primary', () => {
    const f = { ...base, geoReplication: true };
    expect(validate(f)).toEqual({});
    expect(validate({ ...f, backupEnabled: false }).geoReplication).toMatch(/enable backups/);
    expect(validate({ ...f, synchronousReplicas: 2, geoInstances: 2 }).geoInstances).toBeDefined();
    expect(validate({ ...base, primarySite: 'recovery' }).primarySite).toBeDefined();
  });

  it("archives to the project's bucket without a destination or credentials of its own", () => {
    const f = { ...base, backupProjectBucket: true, backupDestinationPath: '', backupSecretName: '' };
    expect(validate(f)).toEqual({});
    expect((toSpec(f) as any).backup).toEqual({ enabled: true, retentionPolicy: '30d', schedule: '0 0 2 * * *' });
    // Typed values are ignored once the project's bucket is chosen.
    expect((toSpec({ ...f, backupDestinationPath: 's3://x/y' }) as any).backup).not.toHaveProperty('destinationPath');
    // Without it, the destination and credentials are needed.
    expect(validate({ ...f, backupProjectBucket: false }).backupDestinationPath).toBeDefined();
    const onBucket: PostgresCluster = {
      apiVersion: 'postgres.cndev.nl/v1alpha1',
      kind: 'PostgresCluster',
      metadata: { name: 'orders-db', namespace: 'demo' },
      spec: { instances: 3, backup: { enabled: true, retentionPolicy: '30d', schedule: '0 0 2 * * *' } },
    };
    expect(fromCluster(onBucket).backupProjectBucket).toBe(true);
    expect(fromCluster({ ...onBucket, spec: { backup: { enabled: false } } }).backupProjectBucket).toBe(false);
    expect(fromCluster({ ...onBucket, spec: { backup: { enabled: true, destinationPath: 's3://b/p' } } }).backupProjectBucket).toBe(false);
  });

  it('switches the primary over with a patch of just primarySite', () => {
    const replicated: PostgresCluster = {
      apiVersion: 'postgres.cndev.nl/v1alpha1',
      kind: 'PostgresCluster',
      metadata: { name: 'orders-db', namespace: 'demo' },
      spec: {
        instances: 3,
        geoReplication: { enabled: true, instances: 2, primarySite: 'protected', promotion: 'Switchover' },
        backup: { enabled: true, destinationPath: 's3://b/p', s3Credentials: { secretName: 's3' } },
      },
    };
    const original = fromCluster(replicated);
    expect(original).toMatchObject({ geoReplication: true, geoInstances: 2, primarySite: 'protected' });
    expect(toEditPatch(original, original)).toEqual({});
    expect(toEditPatch(original, { ...original, primarySite: 'recovery' })).toEqual({
      geoReplication: { primarySite: 'recovery' },
    });
    expect(toEditPatch(original, { ...original, primarySite: 'recovery', promotion: 'Failover' })).toEqual({
      geoReplication: { primarySite: 'recovery', promotion: 'Failover' },
    });
    expect(toEditPatch(original, { ...original, geoReplication: false })).toEqual({
      geoReplication: { enabled: false },
    });
  });
});

describe('audit logging', () => {
  const cluster = (parameters?: Record<string, string>) =>
    ({
      apiVersion: 'postgres.cndev.nl/v1alpha1',
      kind: 'PostgresCluster',
      metadata: { name: 'orders-db', namespace: 'demo' },
      spec: { postgresVersion: 17, instances: 3, ...(parameters ? { postgresql: { parameters } } : {}) },
    }) as PostgresCluster;

  it('sets pgaudit.log on a new cluster only when switched on', () => {
    expect(toSpec({ ...defaultForm('demo'), name: 'x' })).not.toHaveProperty('postgresql');
    expect(toSpec({ ...defaultForm('demo'), name: 'x', auditEnabled: true, auditLog: 'WRITE ,ddl' })).toMatchObject({
      postgresql: { parameters: { 'pgaudit.log': 'write, ddl' } },
    });
  });

  it('validates the classes', () => {
    const form = { ...defaultForm('demo'), name: 'x', auditEnabled: true };
    expect(validate({ ...form, auditLog: 'ddl, -misc' }).auditLog).toBeUndefined();
    expect(validate({ ...form, auditLog: 'ddl; drop' }).auditLog).toBeDefined();
    expect(validate({ ...form, auditEnabled: false, auditLog: 'bogus' }).auditLog).toBeUndefined();
  });

  it('reads it from an existing cluster', () => {
    expect(fromCluster(cluster({ 'pgaudit.log': 'ddl' }))).toMatchObject({ auditEnabled: true, auditLog: 'ddl' });
    expect(fromCluster(cluster({ 'pgaudit.log': 'none' }))).toMatchObject({ auditEnabled: false, auditLog: 'ddl, role' });
    expect(fromCluster(cluster())).toMatchObject({ auditEnabled: false });
  });

  it('patches only pgaudit.log, keeping other parameters', () => {
    const on = fromCluster(cluster({ 'pgaudit.log': 'ddl', max_connections: '200' }));
    expect(toEditPatch(on, { ...on, auditEnabled: false })).toEqual({
      postgresql: { parameters: { 'pgaudit.log': null } },
    });
    expect(toEditPatch(on, { ...on, auditLog: 'all' })).toEqual({
      postgresql: { parameters: { 'pgaudit.log': 'all' } },
    });
    const off = fromCluster(cluster({ max_connections: '200' }));
    expect(toEditPatch(off, off)).toEqual({});
    expect(toEditPatch(off, { ...off, auditEnabled: true })).toEqual({
      postgresql: { parameters: { 'pgaudit.log': 'ddl, role' } },
    });
  });
});

describe('extensions', () => {
  const cluster = (extensions?: string[]) =>
    ({
      apiVersion: 'postgres.cndev.nl/v1alpha1',
      kind: 'PostgresCluster',
      metadata: { name: 'docs-db', namespace: 'demo' },
      spec: { postgresVersion: 17, instances: 3, database: { name: 'docs', owner: 'docs', ...(extensions ? { extensions } : {}) } },
    }) as PostgresCluster;

  it('lists them in the bootstrap database of a new cluster, only when picked', () => {
    expect(toSpec({ ...defaultForm('demo'), name: 'x' })).toMatchObject({ database: { name: 'app', owner: 'app' } });
    expect(toSpec({ ...defaultForm('demo'), name: 'x' }).database).not.toHaveProperty('extensions');
    expect(toSpec({ ...defaultForm('demo'), name: 'x', extensions: ['vector'] })).toMatchObject({
      database: { name: 'app', owner: 'app', extensions: ['vector'] },
    });
  });

  it('reads them from an existing cluster', () => {
    expect(fromCluster(cluster(['vector', 'pg_trgm'])).extensions).toEqual(['vector', 'pg_trgm']);
    expect(fromCluster(cluster()).extensions).toEqual([]);
  });

  it('patches only the list, and the empty list when the last one goes', () => {
    const none = fromCluster(cluster());
    expect(toEditPatch(none, none)).toEqual({});
    expect(toEditPatch(none, { ...none, extensions: ['vector'] })).toEqual({ database: { extensions: ['vector'] } });
    const some = fromCluster(cluster(['vector', 'pg_trgm']));
    expect(toEditPatch(some, { ...some, extensions: ['vector'] })).toEqual({ database: { extensions: ['vector'] } });
    expect(toEditPatch(some, { ...some, extensions: [] })).toEqual({ database: { extensions: [] } });
  });
});

describe('workload profile', () => {
  const catalog = parseExtensions({
    extensions: [
      { name: 'vector' },
      { name: 'vchord', image: { reference: 'vchord@sha256:a' } },
      { name: 'pg_trgm' },
      { name: 'pg_search', image: { reference: 'pg_search@sha256:b' } },
    ],
  });

  it('presets a new vector cluster: PostgreSQL 18 and the extensions the catalog offers, in catalog order', () => {
    const f = selectProfile({ ...defaultForm('demo'), extensions: ['pg_trgm'] }, 'vector', catalog, { preset: true });
    expect(f.profile).toBe('vector');
    // A RAG cluster serves the app tier in its location: internal, like every cluster by default.
    expect(f.exposeEnabled).toBe(false);
    expect(toSpec(f).expose).toBeUndefined();
    expect(f.postgresVersion).toBe(18);
    expect(f.extensions).toEqual(['vector', 'vchord', 'pg_trgm', 'pg_search']);
    expect(toSpec(f)).toMatchObject({ profile: 'vector', postgresVersion: 18 });
  });

  it('only changes the profile of an existing cluster', () => {
    const f = selectProfile(defaultForm('demo'), 'vector', catalog);
    expect(f).toMatchObject({ profile: 'vector', postgresVersion: 17, extensions: [] });
    expect(validate(f).postgresVersion).toMatch(/PostgreSQL 18/);
  });

  it('leaves general out of a new spec', () => {
    expect(toSpec(defaultForm('demo'))).not.toHaveProperty('profile');
    expect(toSpec(defaultForm('demo'), { explicit: true })).toHaveProperty('profile', 'general');
  });

  it('reads the profile back', () => {
    const cluster: PostgresCluster = {
      apiVersion: 'postgres.cndev.nl/v1alpha1',
      kind: 'PostgresCluster',
      metadata: { name: 'rag', namespace: 'demo' },
      spec: { profile: 'vector', postgresVersion: 18 },
    };
    expect(fromCluster(cluster).profile).toBe('vector');
  });

  it('unticks image extensions when going below PostgreSQL 18', () => {
    const f = selectPostgresVersion({ ...defaultForm('demo'), postgresVersion: 18, extensions: ['vector', 'vchord'] }, 17, catalog);
    expect(f.extensions).toEqual(['vector']);
  });
});
