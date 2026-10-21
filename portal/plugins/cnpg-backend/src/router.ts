import {
  HttpAuthService,
  PermissionsService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import { ConflictError, InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import {
  AuthorizeResult,
  BasicPermission,
} from '@backstage/plugin-permission-common';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod/v3';
import {
  cnpgBucketDeletePermission,
  cnpgCacheCreatePermission,
  cnpgCacheCredentialsReadPermission,
  cnpgCacheDeletePermission,
  cnpgCacheReadPermission,
  cnpgCacheUpdatePermission,
  cnpgBucketReadPermission,
  cnpgClusterCreatePermission,
  cnpgClusterCredentialsReadPermission,
  cnpgClusterDeletePermission,
  cnpgClusterFailoverPermission,
  cnpgClusterReadPermission,
  cnpgClusterRestorePermission,
  cnpgClusterSwitchoverPermission,
  cnpgClusterUpdatePermission,
  cnpgLocationCreatePermission,
  cnpgLocationDeletePermission,
  cnpgLocationReadPermission,
  cnpgLocationUpdatePermission,
  cnpgProjectCreatePermission,
  cnpgProjectAuditReadPermission,
  cnpgProjectDeletePermission,
  cnpgProjectReadPermission,
  cnpgProjectUpdatePermission,
  cnpgVolumeDeletePermission,
  cnpgVolumeReadPermission,
  clusterRestoreSource,
  LOCAL_LOCATION,
  LOCATION_ENVIRONMENTS,
  LOCATION_PROVIDERS,
  LocationSummary,
  movesPrimary,
  Project,
  PostgresCluster,
  promotionPatch,
  PostgresClusterSummary,
  parseSizes,
  parseExtensions,
  projectLocations,
  RestoreSource,
  restoreSpec,
  serverRestoreSource,
  summarize,
  summarizeCache,
  summarizeProject,
  targetTimeError,
  ValkeyCacheSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { AuditService } from './service/AuditService';
import { BucketService } from './service/BucketService';
import { CnpgKubernetesService } from './service/CnpgKubernetesService';
import { MAX_KUBECONFIG_BYTES } from './service/kubeconfig';
import { LocationService, withTimeout } from './service/LocationService';
import { ValkeyService } from './service/ValkeyService';
import { VolumeService } from './service/VolumeService';

// DNS-1123 label, short enough that CNPG's derived names (<name>-pooler-rw,
// <name>-1, ...) stay within Kubernetes' limits.
const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const name = z.string().regex(NAME, 'lowercase letters, digits and "-", max 40 characters');
const namespace = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, 'invalid project');
const labelValue = z.string().regex(/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/).max(63);

const createSchema = z.object({
  name,
  namespace,
  /** Passed through to the XR; validated by the API server against the XRD. */
  spec: z.record(z.unknown()),
  owner: labelValue.optional(),
  dryRun: z.boolean().optional(),
});

const updateSchema = z.object({
  spec: z.record(z.unknown()),
});

/**
 * A JSON merge patch of the spec: only the fields present change, null
 * removes one. The XRD decides what may change on a live object.
 */
const patchSchema = z.object({
  spec: z.record(z.unknown()),
  /** New catalog owner; null removes it. */
  owner: labelValue.nullable().optional(),
  dryRun: z.boolean().optional(),
});

/** Move the primary of a geo-replicated cluster to the other site. */
const promoteSchema = z.object({
  site: z.enum(['protected', 'recovery']),
  mode: z.enum(['Switchover', 'Failover']),
  dryRun: z.boolean().optional(),
});

/**
 * A new cluster in the project from a backup folder: a cluster's current one
 * (from.cluster), or one in the Project's inventory of its bucket
 * (from.serverName), also of clusters deleted since.
 */
const restoreSchema = z.object({
  name,
  from: z.union([
    z.object({ cluster: name }),
    z.object({ serverName: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'invalid backup folder').max(128) }),
  ]),
  /** RFC 3339; unset restores the latest state. */
  targetTime: z.string().max(40).optional(),
  storageSize: z.string().regex(/^[0-9]+(Mi|Gi|Ti)$/, 'e.g. 20Gi').optional(),
  dryRun: z.boolean().optional(),
});

/** Moving the primary has its own endpoint and permissions; edits may not do it. */
function assertKeepsPrimary(existing: PostgresCluster, spec: Record<string, unknown>) {
  if (movesPrimary(existing, spec.geoReplication as Record<string, unknown> | undefined)) {
    throw new InputError(
      'geoReplication.primarySite/promotion change the primary site: use POST /clusters/:namespace/:name/promote',
    );
  }
}

const ownerLabel = (owner: string | null | undefined) =>
  owner === undefined ? undefined : { 'backstage.io/owner': owner || null };

const logsQuery = z.object({
  pod: z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, 'invalid pod name'),
  /** Location the pod runs in; the cluster must run there. */
  location: name.optional(),
  tailLines: z.coerce.number().int().min(1).max(5000).default(500),
  sinceSeconds: z.coerce.number().int().min(1).optional(),
  previous: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),
});

const createProjectSchema = z.object({
  // Also the namespace name; the XRD enforces the same rules.
  name: name.refine(v => !v.includes('--'), 'must not contain "--"'),
  owner: labelValue.optional(),
  description: z.string().max(200).optional(),
  /** Passed through to the XR; validated by the API server against the XRD. */
  spec: z.record(z.unknown()).optional(),
  dryRun: z.boolean().optional(),
});

const locationSpecSchema = z
  .object({
    displayName: z.string().max(80).optional(),
    description: z.string().max(300).optional(),
    environment: z.enum(LOCATION_ENVIRONMENTS).optional(),
    provider: z.enum(LOCATION_PROVIDERS).optional(),
    region: z.string().max(63).optional(),
    owner: labelValue.optional(),
    storageClass: z
      .string()
      .regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, 'invalid StorageClass name')
      .optional(),
    schedulable: z.boolean().optional(),
  })
  .strict();

const kubeconfigText = z.string().min(1).max(MAX_KUBECONFIG_BYTES);

const createLocationSchema = z.object({
  name: name.refine(v => v !== LOCAL_LOCATION, `"${LOCAL_LOCATION}" is reserved`),
  kubeconfig: kubeconfigText,
  /** Context to keep; defaults to the kubeconfig's current-context. */
  context: z.string().max(253).optional(),
  spec: locationSpecSchema.default({}),
  /** Validate and probe the kubeconfig without storing anything. */
  dryRun: z.boolean().optional(),
});

const updateLocationSchema = z.object({
  /** Replaces all settings. */
  spec: locationSpecSchema,
  /** Replaces the kubeconfig when given. */
  kubeconfig: kubeconfigText.optional(),
  context: z.string().max(253).optional(),
  dryRun: z.boolean().optional(),
});

/** Adds the Projects that use each location (as protected or recovery site). */
function withProjects(location: LocationSummary, projects: Project[]): LocationSummary {
  return {
    ...location,
    projects: projects
      .filter(p => projectLocations(p).includes(location.name))
      .map(p => p.metadata.name)
      .sort(),
  };
}

/** Adds the cluster's Project (same name as its namespace) and that project's Grafana. */
function withProject(
  summary: PostgresClusterSummary,
  project: Project | undefined,
): PostgresClusterSummary {
  if (!project) return summary;
  return {
    ...summary,
    project: project.metadata.name,
    grafanaUrl: project.status?.grafana?.url || undefined,
  };
}

/** Adds the cache's Project (same name as its namespace) and that project's Grafana. */
function withCacheProject(summary: ValkeyCacheSummary, project: Project | undefined): ValkeyCacheSummary {
  if (!project) return summary;
  return { ...summary, project: project.metadata.name, grafanaUrl: project.status?.grafana?.url || undefined };
}

export async function createRouter(options: {
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  config: RootConfigService;
  k8s: CnpgKubernetesService;
  locations: LocationService;
  buckets: BucketService;
  volumes: VolumeService;
  audit: AuditService;
  valkey: ValkeyService;
}): Promise<express.Router> {
  const { httpAuth, permissions, config, k8s, locations, buckets, volumes, audit, valkey } = options;
  const router = Router();
  // Uploaded kubeconfigs can carry a few certificates.
  router.use(express.json({ limit: '1mb' }));

  const authorize = async (req: express.Request, permission: BasicPermission) => {
    const credentials = await httpAuth.credentials(req);
    const [decision] = await permissions.authorize([{ permission }], { credentials });
    if (decision.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError(`Missing permission ${permission.name}`);
    }
  };

  const params = (req: express.Request) => {
    const parsed = z.object({ namespace, name }).safeParse(req.params);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    return parsed.data;
  };

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Static settings the UI needs (Grafana link target, form defaults).
  router.get('/config', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    res.json({
      grafanaUrl: config.getOptionalString('cnpg.grafanaUrl'),
      defaultNamespace: config.getOptionalString('cnpg.defaultNamespace'),
      storageClasses: config.getOptionalStringArray('cnpg.storageClasses') ?? [],
    });
  });

  // The sizes (SKUs) spec.size can name; empty without a catalog.
  router.get('/sizes', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    res.json({ items: parseSizes(await k8s.sizesCatalog()) });
  });

  // The extensions a cluster may add to its databases; empty without a catalog.
  router.get('/extensions', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    res.json({ items: parseExtensions(await k8s.extensionsCatalog()) });
  });

  router.get('/namespaces', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    res.json({ items: await k8s.namespaces() });
  });

  router.get('/clusters', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    const ns = typeof req.query.namespace === 'string' ? req.query.namespace : undefined;
    const [items, projects] = await Promise.all([k8s.list(ns), k8s.listProjects()]);
    const byName = new Map(projects.map(p => [p.metadata.name, p]));
    res.json({
      items: items.map(c => {
        const project = byName.get(c.metadata.namespace);
        return withProject(summarize(c, project), project);
      }),
    });
  });

  router.get('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    const p = params(req);
    const [details, project] = await Promise.all([
      k8s.details(p.namespace, p.name, location => locations.kubeConfig(location)),
      // Not a project namespace, or no Project API: no project info.
      k8s.getProject(p.namespace).catch(() => undefined),
    ]);
    res.json({ ...details, summary: withProject(summarize(details.resource, project), project) });
  });

  router.get('/clusters/:namespace/:name/logs', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    const p = params(req);
    const q = logsQuery.safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    res.json(await k8s.logs(p.namespace, p.name, q.data, location => locations.kubeConfig(location)));
  });

  router.get('/clusters/:namespace/:name/connection', async (req, res) => {
    await authorize(req, cnpgClusterReadPermission);
    await authorize(req, cnpgClusterCredentialsReadPermission);
    const p = params(req);
    // Carries the password: keep it out of every cache.
    res.set('Cache-Control', 'no-store');
    res.json(await k8s.connection(p.namespace, p.name, location => locations.kubeConfig(location)));
  });

  // Locations: Kubernetes clusters the platform can use. The kubeconfig goes
  // in, never out; responses carry only server, context and auth type.
  router.get('/locations', async (req, res) => {
    await authorize(req, cnpgLocationReadPermission);
    const [items, projects] = await Promise.all([locations.list(), k8s.listProjects()]);
    res.json({ items: items.map(l => withProjects(l, projects)) });
  });

  router.get('/locations/:name', async (req, res) => {
    await authorize(req, cnpgLocationReadPermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    const [location, projects] = await Promise.all([
      locations.get(p.data.name),
      k8s.listProjects(),
    ]);
    res.json(withProjects(location, projects));
  });

  // Probe again now instead of using the cached result.
  router.post('/locations/:name/check', async (req, res) => {
    await authorize(req, cnpgLocationReadPermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    const [location, projects] = await Promise.all([
      locations.get(p.data.name, { refresh: true }),
      k8s.listProjects(),
    ]);
    res.json(withProjects(location, projects));
  });

  router.post('/locations', async (req, res) => {
    await authorize(req, cnpgLocationCreatePermission);
    const parsed = createLocationSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { dryRun, ...location } = parsed.data;
    if (dryRun) {
      res.json({ health: await locations.test(location) });
      return;
    }
    res.status(201).json(await locations.create(location));
  });

  router.put('/locations/:name', async (req, res) => {
    await authorize(req, cnpgLocationUpdatePermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    const parsed = updateLocationSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { dryRun, ...update } = parsed.data;
    if (dryRun) {
      // Only a new kubeconfig has anything to test; settings are checked by the schema.
      res.json({
        health: update.kubeconfig
          ? await locations.test({ kubeconfig: update.kubeconfig, context: update.context })
          : (await locations.get(p.data.name, { refresh: true })).health,
      });
      return;
    }
    res.json(await locations.update(p.data.name, update));
  });

  router.delete('/locations/:name', async (req, res) => {
    await authorize(req, cnpgLocationDeletePermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    // Without its credentials Crossplane can neither update nor clean up
    // what runs there, so a location goes only once no Project uses it.
    const users = withProjects(await locations.get(p.data.name), await k8s.listProjects()).projects;
    if (users?.length) {
      throw new ConflictError(
        `Location ${p.data.name} is used by project ${users.join(', ')}; a project's locations can't change, so it can go once those projects are deleted`,
      );
    }
    await locations.delete(p.data.name);
    res.json({ status: 'deleted' });
  });

  router.get('/projects', async (req, res) => {
    await authorize(req, cnpgProjectReadPermission);
    const items = await k8s.listProjects();
    res.json({
      items: items.map(summarizeProject).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  router.get('/projects/:name', async (req, res) => {
    await authorize(req, cnpgProjectReadPermission);
    const parsed = z.object({ name }).safeParse(req.params);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const resource = await k8s.getProject(parsed.data.name);
    const summary = summarizeProject(resource);
    // Why a location can't reach the backup bucket is in its check job's log there.
    await Promise.all(
      (summary.backupBucket?.reachability ?? [])
        .filter(r => r.state === 'Unreachable')
        .map(async r => {
          r.detail = await withTimeout(
            k8s.backupCheckDetail(resource.metadata.name, r.location, l => locations.kubeConfig(l)),
          ).catch(e => `couldn't read the check's log in ${r.location}: ${(e as Error).message}`);
        }),
    );
    res.json({ summary, resource });
  });

  // Audit logs: the Kubernetes events of the project's namespace (control
  // plane and locations) and the pgaudit records of its PostgreSQL instances.
  router.get('/projects/:name/audit', async (req, res) => {
    await authorize(req, cnpgProjectReadPermission);
    await authorize(req, cnpgProjectAuditReadPermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    const q = z
      .object({ tailLines: z.coerce.number().int().min(1).max(20_000).default(5000) })
      .safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    // Statements can carry data: keep them out of every cache.
    res.set('Cache-Control', 'no-store');
    res.json(await audit.list({ project: p.data.name, tailLines: q.data.tailLines }));
  });

  router.post('/projects', async (req, res) => {
    await authorize(req, cnpgProjectCreatePermission);
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { name: projectName, owner, description, spec, dryRun } = parsed.data;
    const created = await k8s.applyProject({
      name: projectName,
      spec: {
        ...spec,
        ...(owner ? { owner } : {}),
        ...(description ? { description } : {}),
      },
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
      dryRun,
    });
    res.status(dryRun ? 200 : 201).json(created);
  });

  router.patch('/projects/:name', async (req, res) => {
    await authorize(req, cnpgProjectUpdatePermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    const parsed = patchSchema.omit({ owner: true }).safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, dryRun } = parsed.data;
    // The owner lives in the spec and, for the catalog, in a label; keep both in step.
    let owner: string | null | undefined;
    if ('owner' in spec) {
      const o = labelValue.nullable().safeParse(spec.owner || null);
      if (!o.success) throw new InputError(`owner: ${o.error.issues[0]?.message}`);
      owner = o.data;
      spec.owner = owner;
    }
    res.json(
      await k8s.patchProject({ name: p.data.name, spec, labels: ownerLabel(owner), dryRun }),
    );
  });

  router.delete('/projects/:name', async (req, res) => {
    await authorize(req, cnpgProjectDeletePermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    await k8s.getProject(p.data.name);
    // Deleting the project deletes its namespace, and with it every
    // PostgresCluster and ValkeyCache: only an empty project goes.
    const clusters = (await k8s.list(p.data.name)).map(c => c.metadata.name);
    if (clusters.length) {
      throw new ConflictError(
        `Project ${p.data.name} still has PostgreSQL clusters: ${clusters.sort().join(', ')}; delete them first`,
      );
    }
    const caches = (await valkey.list(p.data.name)).map(c => c.metadata.name);
    if (caches.length) {
      throw new ConflictError(
        `Project ${p.data.name} still has Valkey caches: ${caches.sort().join(', ')}; delete them first`,
      );
    }
    await k8s.deleteProject(p.data.name);
    res.json({ status: 'deleting' });
  });

  // Buckets on the object store account COSI uses, also those of deleted
  // Projects. Only an orphaned one (nothing on the cluster uses it) can go.
  const bucketName = z.object({ name: z.string().regex(/^[a-z0-9][-a-z0-9.]{1,61}[a-z0-9]$/, 'invalid bucket name') });

  router.get('/buckets', async (req, res) => {
    await authorize(req, cnpgBucketReadPermission);
    res.json(await buckets.list());
  });

  router.get('/buckets/:name', async (req, res) => {
    await authorize(req, cnpgBucketReadPermission);
    const p = bucketName.safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    res.json(await buckets.get(p.data.name));
  });

  router.delete('/buckets/:name', async (req, res) => {
    await authorize(req, cnpgBucketDeletePermission);
    const p = bucketName.safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    await buckets.delete(p.data.name);
    res.json({ status: 'deleted' });
  });

  // The disks of PostgreSQL instances in every project's locations. Only an
  // orphaned one (its PostgresCluster is gone) can go, with its storage.
  const k8sName = z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, 'invalid name');

  router.get('/volumes', async (req, res) => {
    await authorize(req, cnpgVolumeReadPermission);
    const q = z.object({ project: namespace.optional() }).safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    res.json(await volumes.list(q.data));
  });

  router.delete('/volumes/:location/claims/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgVolumeDeletePermission);
    const p = z.object({ location: name, namespace, name: k8sName }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    await volumes.deleteClaim(p.data.location, p.data.namespace, p.data.name);
    res.json({ status: 'deleted' });
  });

  router.delete('/volumes/:location/persistentvolumes/:name', async (req, res) => {
    await authorize(req, cnpgVolumeDeletePermission);
    const p = z.object({ location: name, name: k8sName }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    await volumes.deleteVolume(p.data.location, p.data.name);
    res.json({ status: 'deleted' });
  });

  // Valkey caches (cache.cndev.nl ValkeyCache), in a project's protected
  // location. The spec goes to the XR as-is: the XRD validates it.
  router.get('/caches', async (req, res) => {
    await authorize(req, cnpgCacheReadPermission);
    const q = z.object({ namespace: namespace.optional() }).safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    const [items, projects] = await Promise.all([valkey.list(q.data.namespace), k8s.listProjects()]);
    const byName = new Map(projects.map(p => [p.metadata.name, p]));
    res.json({
      items: items.map(c => {
        const project = byName.get(c.metadata.namespace);
        return withCacheProject(summarizeCache(c, project), project);
      }),
    });
  });

  router.get('/caches/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgCacheReadPermission);
    const p = params(req);
    const [details, project] = await Promise.all([
      valkey.details(p.namespace, p.name, location => locations.kubeConfig(location)),
      k8s.getProject(p.namespace).catch(() => undefined),
    ]);
    res.json({
      ...details,
      summary: withCacheProject(summarizeCache(details.resource, project), project),
    });
  });

  router.get('/caches/:namespace/:name/connection', async (req, res) => {
    await authorize(req, cnpgCacheReadPermission);
    await authorize(req, cnpgCacheCredentialsReadPermission);
    const p = params(req);
    // Carries the password: keep it out of every cache.
    res.set('Cache-Control', 'no-store');
    res.json(await valkey.connection(p.namespace, p.name, location => locations.kubeConfig(location)));
  });

  router.post('/caches', async (req, res) => {
    await authorize(req, cnpgCacheCreatePermission);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { owner, ...rest } = parsed.data;
    const created = await valkey.apply({
      ...rest,
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
    });
    res.status(parsed.data.dryRun ? 200 : 201).json(created);
  });

  router.patch('/caches/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgCacheUpdatePermission);
    const p = params(req);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun } = parsed.data;
    res.json(await valkey.patch({ ...p, spec, labels: ownerLabel(owner), dryRun }));
  });

  router.delete('/caches/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgCacheDeletePermission);
    const p = params(req);
    await valkey.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  router.post('/clusters', async (req, res) => {
    await authorize(req, cnpgClusterCreatePermission);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    // A restore copies another cluster's data: the same permission as the restore endpoint.
    if (parsed.data.spec.restore !== undefined) await authorize(req, cnpgClusterRestorePermission);
    const { owner, ...rest } = parsed.data;
    const created = await k8s.apply({
      ...rest,
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
    });
    res.status(parsed.data.dryRun ? 200 : 201).json(created);
  });

  router.post('/projects/:name/restore', async (req, res) => {
    await authorize(req, cnpgClusterCreatePermission);
    await authorize(req, cnpgClusterRestorePermission);
    const p = z.object({ name: namespace }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    const project = p.data.name;
    const parsed = restoreSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { from, targetTime, storageSize, dryRun } = parsed.data;
    let source: RestoreSource;
    // The cluster the folder belongs to, while it exists, gives the copy its settings.
    let base: PostgresCluster | undefined;
    if ('cluster' in from) {
      base = await k8s.get(project, from.cluster);
      const s = clusterRestoreSource(base);
      if ('error' in s) throw new ConflictError(s.error);
      source = s;
    } else {
      const server = (await k8s.getProject(project)).status?.backup?.servers?.find(
        s => s.serverName === from.serverName,
      );
      if (!server) {
        throw new NotFoundError(`Backup folder ${from.serverName} not found in project ${project}'s bucket`);
      }
      source = serverRestoreSource(server);
      if (server.active && server.cluster) {
        base = await k8s.get(project, server.cluster).catch(() => undefined);
      }
    }
    const invalid = targetTimeError(source, targetTime);
    if (invalid) throw new InputError(invalid);
    const owner = base?.metadata.labels?.['backstage.io/owner'];
    const created = await k8s.apply({
      namespace: project,
      name: parsed.data.name,
      spec: restoreSpec(source, { targetTime, storageSize, base: base?.spec }),
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
      dryRun,
    });
    res.status(dryRun ? 200 : 201).json(created);
  });

  router.put('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterUpdatePermission);
    const p = params(req);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const existing = await k8s.get(p.namespace, p.name);
    // A full spec: a missing geoReplication keeps (or the XRD defaults) the primary site.
    assertKeepsPrimary(existing, {
      geoReplication: { primarySite: undefined, promotion: undefined, ...(parsed.data.spec.geoReplication as object) },
    });
    const owner = existing.metadata.labels?.['backstage.io/owner'];
    res.json(
      await k8s.apply({
        ...p,
        spec: parsed.data.spec,
        labels: owner ? { 'backstage.io/owner': owner } : undefined,
      }),
    );
  });

  router.patch('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterUpdatePermission);
    const p = params(req);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun } = parsed.data;
    assertKeepsPrimary(await k8s.get(p.namespace, p.name), spec);
    res.json(await k8s.patch({ ...p, spec, labels: ownerLabel(owner), dryRun }));
  });

  // Disaster recovery: switch over (lossless) or fail over to the other site.
  router.post('/clusters/:namespace/:name/promote', async (req, res) => {
    const p = params(req);
    const parsed = promoteSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { dryRun, ...request } = parsed.data;
    await authorize(
      req,
      request.mode === 'Failover' ? cnpgClusterFailoverPermission : cnpgClusterSwitchoverPermission,
    );
    const plan = promotionPatch(await k8s.get(p.namespace, p.name), request);
    if ('error' in plan) throw new ConflictError(plan.error);
    res.json(await k8s.patch({ ...p, spec: plan.spec, dryRun }));
  });

  router.delete('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, cnpgClusterDeletePermission);
    const p = params(req);
    await k8s.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  return router;
}
