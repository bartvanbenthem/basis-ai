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
  basisBucketDeletePermission,
  basisCacheCreatePermission,
  basisCacheCredentialsReadPermission,
  basisCacheDeletePermission,
  basisCacheReadPermission,
  basisCacheUpdatePermission,
  basisGatewayCreatePermission,
  basisGatewayCredentialsReadPermission,
  basisGatewayDeletePermission,
  basisGatewayReadPermission,
  basisGatewayUpdatePermission,
  basisMcpCreatePermission,
  basisMcpCredentialsReadPermission,
  basisMcpDeletePermission,
  basisMcpReadPermission,
  basisMcpUpdatePermission,
  basisServerCreatePermission,
  basisServerDeletePermission,
  basisServerReadPermission,
  basisServerUpdatePermission,
  basisStackCreatePermission,
  basisStackCredentialsReadPermission,
  basisStackDeletePermission,
  basisStackReadPermission,
  basisStackUpdatePermission,
  GenAIStackSummary,
  MCPServerSummary,
  ModelGatewaySummary,
  ModelServerSummary,
  STACK_OWNER_LABEL,
  stackPromotionPatch,
  summarizeGateway,
  summarizeMcpServer,
  summarizeServer,
  summarizeStack,
  basisBucketReadPermission,
  basisClusterCreatePermission,
  basisClusterCredentialsReadPermission,
  basisClusterDeletePermission,
  basisClusterFailoverPermission,
  basisClusterReadPermission,
  basisClusterRestorePermission,
  basisClusterSwitchoverPermission,
  basisClusterUpdatePermission,
  basisLocationCreatePermission,
  basisLocationDeletePermission,
  basisLocationReadPermission,
  basisLocationUpdatePermission,
  basisProjectCreatePermission,
  basisProjectAuditReadPermission,
  basisProjectDeletePermission,
  basisProjectReadPermission,
  basisProjectUpdatePermission,
  basisVolumeDeletePermission,
  basisVolumeReadPermission,
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
} from '@internal/backstage-plugin-basis-common';
import { AuditService } from './service/AuditService';
import { CostService } from './service/CostService';
import { BucketService } from './service/BucketService';
import { BasisKubernetesService } from './service/BasisKubernetesService';
import { MAX_KUBECONFIG_BYTES } from './service/kubeconfig';
import { LocationService, withTimeout } from './service/LocationService';
import { GatewayService } from './service/GatewayService';
import { McpService } from './service/McpService';
import { ProviderKeyService } from './service/ProviderKeyService';
import { ServerService } from './service/ServerService';
import { StackService } from './service/StackService';
import { ValkeyService } from './service/ValkeyService';
import { VolumeService } from './service/VolumeService';

// DNS-1123 label, short enough that CNPG's derived names (<name>-pooler-rw,
// <name>-1, ...) stay within Kubernetes' limits.
const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const name = z.string().regex(NAME, 'lowercase letters, digits and "-", max 40 characters');
// Its children (<name>-cache-dr) must fit 40 characters.
const stackName = z.string().regex(/^[a-z]([-a-z0-9]{0,26}[a-z0-9])?$/, 'lowercase letters, digits and "-", max 28 characters');
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

/**
 * Provider API keys entered in a form, by model name: written into Secrets
 * the spec references, never into the spec (see ProviderKeyService).
 */
const providerKeys = z.record(z.string().min(1).max(16384)).optional();

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

/**
 * A database, cache or gateway a stack composes is changed through the stack,
 * not on its own (the API server's admission policy refuses it too).
 */
function assertNotStackOwned(kind: string, resource: { metadata: { name: string; labels?: Record<string, string> } }) {
  const stack = resource.metadata.labels?.[STACK_OWNER_LABEL];
  if (stack) {
    throw new ConflictError(
      `${kind} ${resource.metadata.name} belongs to GenAIStack ${stack}; change or delete the stack instead`,
    );
  }
}

function withStackProject(summary: GenAIStackSummary, project: Project | undefined): GenAIStackSummary {
  return project ? { ...summary, project: project.metadata.name } : summary;
}

function withGatewayProject(summary: ModelGatewaySummary, project: Project | undefined): ModelGatewaySummary {
  return project ? { ...summary, project: project.metadata.name } : summary;
}

/** Adds the server's Project (same name as its namespace) and that project's Grafana. */
function withServerProject(summary: ModelServerSummary, project: Project | undefined): ModelServerSummary {
  if (!project) return summary;
  return { ...summary, project: project.metadata.name, grafanaUrl: project.status?.grafana?.url || undefined };
}

/** Adds the MCP server's Project (same name as its namespace) and that project's Grafana. */
function withMcpProject(summary: MCPServerSummary, project: Project | undefined): MCPServerSummary {
  if (!project) return summary;
  return { ...summary, project: project.metadata.name, grafanaUrl: project.status?.grafana?.url || undefined };
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
  k8s: BasisKubernetesService;
  locations: LocationService;
  buckets: BucketService;
  volumes: VolumeService;
  audit: AuditService;
  cost: CostService;
  valkey: ValkeyService;
  stacks: StackService;
  gateways: GatewayService;
  servers: ServerService;
  mcp: McpService;
  providerKeys: ProviderKeyService;
}): Promise<express.Router> {
  const { httpAuth, permissions, config, k8s, locations, buckets, volumes, audit, cost, valkey, stacks, gateways, servers, mcp } =
    options;
  /** The MCP servers in a project over a stack's or a cluster's database. */
  const mcpServersOn = async (ns: string, kind: 'stack' | 'cluster', db: string) =>
    (await mcp.list(ns))
      .filter(m => m.spec.database?.[kind] === db)
      .map(m => m.metadata.name)
      .sort();
  const keys = options.providerKeys;
  /** A stack's or gateway's models, in its spec. */
  const stackModels = (spec: Record<string, any> | undefined) => spec?.gateway?.models;
  const gatewayModels = (spec: Record<string, any> | undefined) => spec?.models;
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
    await authorize(req, basisClusterReadPermission);
    res.json({
      grafanaUrl: config.getOptionalString('basis.grafanaUrl'),
      defaultNamespace: config.getOptionalString('basis.defaultNamespace'),
      storageClasses: config.getOptionalStringArray('basis.storageClasses') ?? [],
    });
  });

  // The sizes (SKUs) spec.size can name; empty without a catalog.
  router.get('/sizes', async (req, res) => {
    await authorize(req, basisClusterReadPermission);
    res.json({ items: parseSizes(await k8s.sizesCatalog()) });
  });

  // The extensions a cluster may add to its databases; empty without a catalog.
  router.get('/extensions', async (req, res) => {
    await authorize(req, basisClusterReadPermission);
    res.json({ items: parseExtensions(await k8s.extensionsCatalog()) });
  });

  router.get('/namespaces', async (req, res) => {
    await authorize(req, basisClusterReadPermission);
    res.json({ items: await k8s.namespaces() });
  });

  router.get('/clusters', async (req, res) => {
    await authorize(req, basisClusterReadPermission);
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
    await authorize(req, basisClusterReadPermission);
    const p = params(req);
    const [details, project] = await Promise.all([
      k8s.details(p.namespace, p.name, location => locations.kubeConfig(location)),
      // Not a project namespace, or no Project API: no project info.
      k8s.getProject(p.namespace).catch(() => undefined),
    ]);
    res.json({ ...details, summary: withProject(summarize(details.resource, project), project) });
  });

  router.get('/clusters/:namespace/:name/logs', async (req, res) => {
    await authorize(req, basisClusterReadPermission);
    const p = params(req);
    const q = logsQuery.safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    res.json(await k8s.logs(p.namespace, p.name, q.data, location => locations.kubeConfig(location)));
  });

  router.get('/clusters/:namespace/:name/connection', async (req, res) => {
    await authorize(req, basisClusterReadPermission);
    await authorize(req, basisClusterCredentialsReadPermission);
    const p = params(req);
    // Carries the password: keep it out of every cache.
    res.set('Cache-Control', 'no-store');
    res.json(await k8s.connection(p.namespace, p.name, location => locations.kubeConfig(location)));
  });

  // Locations: Kubernetes clusters the platform can use. The kubeconfig goes
  // in, never out; responses carry only server, context and auth type.
  router.get('/locations', async (req, res) => {
    await authorize(req, basisLocationReadPermission);
    const [items, projects] = await Promise.all([locations.list(), k8s.listProjects()]);
    res.json({ items: items.map(l => withProjects(l, projects)) });
  });

  router.get('/locations/:name', async (req, res) => {
    await authorize(req, basisLocationReadPermission);
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
    await authorize(req, basisLocationReadPermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    const [location, projects] = await Promise.all([
      locations.get(p.data.name, { refresh: true }),
      k8s.listProjects(),
    ]);
    res.json(withProjects(location, projects));
  });

  router.post('/locations', async (req, res) => {
    await authorize(req, basisLocationCreatePermission);
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
    await authorize(req, basisLocationUpdatePermission);
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
    await authorize(req, basisLocationDeletePermission);
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
    await authorize(req, basisProjectReadPermission);
    const items = await k8s.listProjects();
    res.json({
      items: items.map(summarizeProject).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  router.get('/projects/:name', async (req, res) => {
    await authorize(req, basisProjectReadPermission);
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
    await authorize(req, basisProjectReadPermission);
    await authorize(req, basisProjectAuditReadPermission);
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

  // The project's cost and token use, from its Prometheus (the Project's cost rules).
  router.get('/projects/:name/cost', async (req, res) => {
    await authorize(req, basisProjectReadPermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    res.json(await cost.get(p.data.name));
  });

  router.post('/projects', async (req, res) => {
    await authorize(req, basisProjectCreatePermission);
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
    await authorize(req, basisProjectUpdatePermission);
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
    await authorize(req, basisProjectDeletePermission);
    const p = z.object({ name }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    await k8s.getProject(p.data.name);
    // Deleting the project deletes its namespace, and with it every MCPServer,
    // GenAIStack, ModelGateway, ModelServer, PostgresCluster and ValkeyCache: only an empty project goes.
    const mcpNames = (await mcp.list(p.data.name)).map(m => m.metadata.name);
    if (mcpNames.length) {
      throw new ConflictError(
        `Project ${p.data.name} still has MCP servers: ${mcpNames.sort().join(', ')}; delete them first`,
      );
    }
    const stackNames = (await stacks.list(p.data.name)).map(s => s.metadata.name);
    if (stackNames.length) {
      throw new ConflictError(
        `Project ${p.data.name} still has GenAI stacks: ${stackNames.sort().join(', ')}; delete them first`,
      );
    }
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
    const gws = (await gateways.list(p.data.name)).map(g => g.metadata.name);
    if (gws.length) {
      throw new ConflictError(
        `Project ${p.data.name} still has model gateways: ${gws.sort().join(', ')}; delete them first`,
      );
    }
    const srvs = (await servers.list(p.data.name)).map(s => s.metadata.name);
    if (srvs.length) {
      throw new ConflictError(
        `Project ${p.data.name} still has model servers: ${srvs.sort().join(', ')}; delete them first`,
      );
    }
    await k8s.deleteProject(p.data.name);
    res.json({ status: 'deleting' });
  });

  // Buckets on the object store account COSI uses, also those of deleted
  // Projects. Only an orphaned one (nothing on the cluster uses it) can go.
  const bucketName = z.object({ name: z.string().regex(/^[a-z0-9][-a-z0-9.]{1,61}[a-z0-9]$/, 'invalid bucket name') });

  router.get('/buckets', async (req, res) => {
    await authorize(req, basisBucketReadPermission);
    res.json(await buckets.list());
  });

  router.get('/buckets/:name', async (req, res) => {
    await authorize(req, basisBucketReadPermission);
    const p = bucketName.safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    res.json(await buckets.get(p.data.name));
  });

  router.delete('/buckets/:name', async (req, res) => {
    await authorize(req, basisBucketDeletePermission);
    const p = bucketName.safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    await buckets.delete(p.data.name);
    res.json({ status: 'deleted' });
  });

  // The disks of PostgreSQL instances in every project's locations. Only an
  // orphaned one (its PostgresCluster is gone) can go, with its storage.
  const k8sName = z.string().regex(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, 'invalid name');

  router.get('/volumes', async (req, res) => {
    await authorize(req, basisVolumeReadPermission);
    const q = z.object({ project: namespace.optional() }).safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    res.json(await volumes.list(q.data));
  });

  router.delete('/volumes/:location/claims/:namespace/:name', async (req, res) => {
    await authorize(req, basisVolumeDeletePermission);
    const p = z.object({ location: name, namespace, name: k8sName }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    await volumes.deleteClaim(p.data.location, p.data.namespace, p.data.name);
    res.json({ status: 'deleted' });
  });

  router.delete('/volumes/:location/persistentvolumes/:name', async (req, res) => {
    await authorize(req, basisVolumeDeletePermission);
    const p = z.object({ location: name, name: k8sName }).safeParse(req.params);
    if (!p.success) throw new InputError(p.error.toString());
    await volumes.deleteVolume(p.data.location, p.data.name);
    res.json({ status: 'deleted' });
  });

  // Valkey caches (cache.cndev.nl ValkeyCache), in a project's protected
  // location. The spec goes to the XR as-is: the XRD validates it.
  router.get('/caches', async (req, res) => {
    await authorize(req, basisCacheReadPermission);
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
    await authorize(req, basisCacheReadPermission);
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
    await authorize(req, basisCacheReadPermission);
    await authorize(req, basisCacheCredentialsReadPermission);
    const p = params(req);
    // Carries the password: keep it out of every cache.
    res.set('Cache-Control', 'no-store');
    res.json(await valkey.connection(p.namespace, p.name, location => locations.kubeConfig(location)));
  });

  router.post('/caches', async (req, res) => {
    await authorize(req, basisCacheCreatePermission);
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
    await authorize(req, basisCacheUpdatePermission);
    const p = params(req);
    assertNotStackOwned('ValkeyCache', await valkey.get(p.namespace, p.name));
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun } = parsed.data;
    res.json(await valkey.patch({ ...p, spec, labels: ownerLabel(owner), dryRun }));
  });

  router.delete('/caches/:namespace/:name', async (req, res) => {
    await authorize(req, basisCacheDeletePermission);
    const p = params(req);
    assertNotStackOwned('ValkeyCache', await valkey.get(p.namespace, p.name));
    await valkey.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  // GenAI stacks (ai.cndev.nl GenAIStack): database, caches, gateway and
  // wiring per site. The spec goes to the XR as-is: the XRD validates it.
  router.get('/stacks', async (req, res) => {
    await authorize(req, basisStackReadPermission);
    const q = z.object({ namespace: namespace.optional() }).safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    const [items, projects] = await Promise.all([stacks.list(q.data.namespace), k8s.listProjects()]);
    const byName = new Map(projects.map(p => [p.metadata.name, p]));
    res.json({
      items: items.map(s => {
        const project = byName.get(s.metadata.namespace);
        return withStackProject(summarizeStack(s, project), project);
      }),
    });
  });

  router.get('/stacks/:namespace/:name', async (req, res) => {
    await authorize(req, basisStackReadPermission);
    const p = params(req);
    const [resource, project] = await Promise.all([
      stacks.get(p.namespace, p.name),
      k8s.getProject(p.namespace).catch(() => undefined),
    ]);
    res.json({ summary: withStackProject(summarizeStack(resource, project), project), resource });
  });

  router.get('/stacks/:namespace/:name/connection', async (req, res) => {
    await authorize(req, basisStackReadPermission);
    await authorize(req, basisStackCredentialsReadPermission);
    const p = params(req);
    // Carries passwords and the gateway key: keep it out of every cache.
    res.set('Cache-Control', 'no-store');
    res.json(await stacks.connection(p.namespace, p.name, location => locations.kubeConfig(location)));
  });

  router.post('/stacks', async (req, res) => {
    await authorize(req, basisStackCreatePermission);
    const parsed = createSchema.extend({ name: stackName, providerKeys }).safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { owner, providerKeys: provided, ...rest } = parsed.data;
    keys.check(rest.name, stackModels(rest.spec), provided);
    const created = await stacks.apply({
      ...rest,
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
    });
    if (provided && !rest.dryRun) await keys.write(created, provided);
    res.status(parsed.data.dryRun ? 200 : 201).json(created);
  });

  router.patch('/stacks/:namespace/:name', async (req, res) => {
    await authorize(req, basisStackUpdatePermission);
    const p = params(req);
    const parsed = patchSchema.extend({ providerKeys }).safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun, providerKeys: provided } = parsed.data;
    if (provided) {
      // The models after the patch: its own list (lists are replaced), else the stack's.
      keys.check(p.name, stackModels(spec) ?? stackModels((await stacks.get(p.namespace, p.name)).spec), provided);
    }
    const patched = await stacks.patch({ ...p, spec, labels: ownerLabel(owner), dryRun });
    if (provided && !dryRun) await keys.write(patched, provided);
    res.json(patched);
  });

  router.delete('/stacks/:namespace/:name', async (req, res) => {
    await authorize(req, basisStackDeletePermission);
    const p = params(req);
    const users = await mcpServersOn(p.namespace, 'stack', p.name);
    if (users.length) {
      throw new ConflictError(`GenAIStack ${p.name} is served by MCP server(s) ${users.join(', ')}; delete them first`);
    }
    await stacks.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  // Switch a stack over (lossless) or fail it over to the other site: its
  // database moves its primary, the cache and gateway follow. The same
  // permissions as moving a database's primary.
  router.post('/stacks/:namespace/:name/promote', async (req, res) => {
    const p = params(req);
    const parsed = promoteSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { dryRun, ...request } = parsed.data;
    await authorize(
      req,
      request.mode === 'Failover' ? basisClusterFailoverPermission : basisClusterSwitchoverPermission,
    );
    const plan = stackPromotionPatch(await stacks.get(p.namespace, p.name), request);
    if ('error' in plan) throw new ConflictError(plan.error);
    res.json(await stacks.patch({ ...p, spec: plan.spec, dryRun }));
  });

  // Model gateways (ai.cndev.nl ModelGateway): an OpenAI-compatible endpoint
  // to a project's models, with a key per client. The spec goes to the XR
  // as-is: the XRD validates it.
  router.get('/gateways', async (req, res) => {
    await authorize(req, basisGatewayReadPermission);
    const q = z.object({ namespace: namespace.optional() }).safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    const [items, projects] = await Promise.all([gateways.list(q.data.namespace), k8s.listProjects()]);
    const byName = new Map(projects.map(p => [p.metadata.name, p]));
    res.json({
      items: items.map(g => {
        const project = byName.get(g.metadata.namespace);
        return withGatewayProject(summarizeGateway(g, project), project);
      }),
    });
  });

  router.get('/gateways/:namespace/:name', async (req, res) => {
    await authorize(req, basisGatewayReadPermission);
    const p = params(req);
    const [resource, project, usedBy] = await Promise.all([
      gateways.get(p.namespace, p.name),
      k8s.getProject(p.namespace).catch(() => undefined),
      stacks.list(p.namespace).catch(() => []),
    ]);
    res.json({
      summary: withGatewayProject(summarizeGateway(resource, project), project),
      resource,
      // The stacks that use it: their own (it's theirs) or shared (spec.gateway.ref).
      stacks: usedBy.map(s => summarizeStack(s)).filter(s => s.gatewayName === p.name).map(s => s.name).sort(),
    });
  });

  router.get('/gateways/:namespace/:name/keys', async (req, res) => {
    await authorize(req, basisGatewayReadPermission);
    await authorize(req, basisGatewayCredentialsReadPermission);
    const p = params(req);
    // Carries API keys: keep them out of every cache.
    res.set('Cache-Control', 'no-store');
    res.json({ items: await gateways.keys(p.namespace, p.name, location => locations.kubeConfig(location)) });
  });

  router.post('/gateways', async (req, res) => {
    await authorize(req, basisGatewayCreatePermission);
    const parsed = createSchema.extend({ providerKeys }).safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { owner, providerKeys: provided, ...rest } = parsed.data;
    keys.check(rest.name, gatewayModels(rest.spec), provided);
    const created = await gateways.apply({
      ...rest,
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
    });
    if (provided && !rest.dryRun) await keys.write(created, provided);
    res.status(parsed.data.dryRun ? 200 : 201).json(created);
  });

  router.patch('/gateways/:namespace/:name', async (req, res) => {
    await authorize(req, basisGatewayUpdatePermission);
    const p = params(req);
    const existing = await gateways.get(p.namespace, p.name);
    assertNotStackOwned('ModelGateway', existing);
    const parsed = patchSchema.extend({ providerKeys }).safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun, providerKeys: provided } = parsed.data;
    keys.check(p.name, gatewayModels(spec) ?? gatewayModels(existing.spec), provided);
    const patched = await gateways.patch({ ...p, spec, labels: ownerLabel(owner), dryRun });
    if (provided && !dryRun) await keys.write(patched, provided);
    res.json(patched);
  });

  router.delete('/gateways/:namespace/:name', async (req, res) => {
    await authorize(req, basisGatewayDeletePermission);
    const p = params(req);
    assertNotStackOwned('ModelGateway', await gateways.get(p.namespace, p.name));
    const users = (await stacks.list(p.namespace)).filter(s => s.spec.gateway?.ref === p.name).map(s => s.metadata.name);
    if (users.length) {
      throw new ConflictError(`ModelGateway ${p.name} is used by stack(s) ${users.sort().join(', ')}; point them elsewhere first`);
    }
    await gateways.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  // Model servers (ai.cndev.nl ModelServer): self-hosted models, vLLM on
  // KServe, which gateways' models name. The spec goes to the XR as-is: the
  // XRD validates it.
  /** The gateways in a project with a model on server name. */
  const gatewaysOn = async (ns: string, server: string) =>
    (await gateways.list(ns))
      .filter(g => (g.spec.models ?? []).some(m => m.server === server))
      .map(g => g.metadata.name)
      .sort();

  router.get('/servers', async (req, res) => {
    await authorize(req, basisServerReadPermission);
    const q = z.object({ namespace: namespace.optional() }).safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    const [items, projects] = await Promise.all([servers.list(q.data.namespace), k8s.listProjects()]);
    const byName = new Map(projects.map(p => [p.metadata.name, p]));
    res.json({
      items: items.map(s => {
        const project = byName.get(s.metadata.namespace);
        return withServerProject(summarizeServer(s, project), project);
      }),
    });
  });

  router.get('/servers/:namespace/:name', async (req, res) => {
    await authorize(req, basisServerReadPermission);
    const p = params(req);
    const [resource, project, users] = await Promise.all([
      servers.get(p.namespace, p.name),
      k8s.getProject(p.namespace).catch(() => undefined),
      gatewaysOn(p.namespace, p.name).catch(() => []),
    ]);
    const workload = await servers.workload(resource, location => locations.kubeConfig(location));
    res.json({
      summary: withServerProject(summarizeServer(resource, project), project),
      resource,
      gateways: users,
      ...workload,
    });
  });

  router.post('/servers', async (req, res) => {
    await authorize(req, basisServerCreatePermission);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { owner, ...rest } = parsed.data;
    const created = await servers.apply({
      ...rest,
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
    });
    res.status(parsed.data.dryRun ? 200 : 201).json(created);
  });

  router.patch('/servers/:namespace/:name', async (req, res) => {
    await authorize(req, basisServerUpdatePermission);
    const p = params(req);
    assertNotStackOwned('ModelServer', await servers.get(p.namespace, p.name));
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun } = parsed.data;
    res.json(await servers.patch({ ...p, spec, labels: ownerLabel(owner), dryRun }));
  });

  router.delete('/servers/:namespace/:name', async (req, res) => {
    await authorize(req, basisServerDeletePermission);
    const p = params(req);
    assertNotStackOwned('ModelServer', await servers.get(p.namespace, p.name));
    const users = await gatewaysOn(p.namespace, p.name);
    if (users.length) {
      throw new ConflictError(`ModelServer ${p.name} is used by gateway(s) ${users.join(', ')}; remove its models there first`);
    }
    await servers.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  // MCP servers (ai.cndev.nl MCPServer): retrieval and agent memory over a
  // stack's or cluster's database as MCP tools, a key per client. The spec
  // goes to the XR as-is: the XRD validates it.
  router.get('/mcp-servers', async (req, res) => {
    await authorize(req, basisMcpReadPermission);
    const q = z.object({ namespace: namespace.optional() }).safeParse(req.query);
    if (!q.success) throw new InputError(q.error.toString());
    const [items, projects] = await Promise.all([mcp.list(q.data.namespace), k8s.listProjects()]);
    const byName = new Map(projects.map(p => [p.metadata.name, p]));
    res.json({
      items: items.map(m => {
        const project = byName.get(m.metadata.namespace);
        return withMcpProject(summarizeMcpServer(m, project), project);
      }),
    });
  });

  router.get('/mcp-servers/:namespace/:name', async (req, res) => {
    await authorize(req, basisMcpReadPermission);
    const p = params(req);
    const [resource, project] = await Promise.all([
      mcp.get(p.namespace, p.name),
      k8s.getProject(p.namespace).catch(() => undefined),
    ]);
    const workload = await mcp.workload(resource, location => locations.kubeConfig(location));
    res.json({ summary: withMcpProject(summarizeMcpServer(resource, project), project), resource, ...workload });
  });

  router.get('/mcp-servers/:namespace/:name/keys', async (req, res) => {
    await authorize(req, basisMcpReadPermission);
    await authorize(req, basisMcpCredentialsReadPermission);
    const p = params(req);
    // Carries API keys: keep them out of every cache.
    res.set('Cache-Control', 'no-store');
    res.json({ items: await mcp.keys(p.namespace, p.name, location => locations.kubeConfig(location)) });
  });

  router.post('/mcp-servers', async (req, res) => {
    await authorize(req, basisMcpCreatePermission);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { owner, ...rest } = parsed.data;
    const created = await mcp.apply({
      ...rest,
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
    });
    res.status(parsed.data.dryRun ? 200 : 201).json(created);
  });

  router.patch('/mcp-servers/:namespace/:name', async (req, res) => {
    await authorize(req, basisMcpUpdatePermission);
    const p = params(req);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun } = parsed.data;
    res.json(await mcp.patch({ ...p, spec, labels: ownerLabel(owner), dryRun }));
  });

  router.delete('/mcp-servers/:namespace/:name', async (req, res) => {
    await authorize(req, basisMcpDeletePermission);
    const p = params(req);
    await mcp.get(p.namespace, p.name);
    await mcp.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  router.post('/clusters', async (req, res) => {
    await authorize(req, basisClusterCreatePermission);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    // A restore copies another cluster's data: the same permission as the restore endpoint.
    if (parsed.data.spec.restore !== undefined) await authorize(req, basisClusterRestorePermission);
    const { owner, ...rest } = parsed.data;
    const created = await k8s.apply({
      ...rest,
      labels: owner ? { 'backstage.io/owner': owner } : undefined,
      createOnly: true,
    });
    res.status(parsed.data.dryRun ? 200 : 201).json(created);
  });

  router.post('/projects/:name/restore', async (req, res) => {
    await authorize(req, basisClusterCreatePermission);
    await authorize(req, basisClusterRestorePermission);
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
    await authorize(req, basisClusterUpdatePermission);
    const p = params(req);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const existing = await k8s.get(p.namespace, p.name);
    assertNotStackOwned('PostgresCluster', existing);
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
    await authorize(req, basisClusterUpdatePermission);
    const p = params(req);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    const { spec, owner, dryRun } = parsed.data;
    const existing = await k8s.get(p.namespace, p.name);
    assertNotStackOwned('PostgresCluster', existing);
    assertKeepsPrimary(existing, spec);
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
      request.mode === 'Failover' ? basisClusterFailoverPermission : basisClusterSwitchoverPermission,
    );
    const existing = await k8s.get(p.namespace, p.name);
    // A stack's database moves with the stack (POST /stacks/:namespace/:name/promote).
    assertNotStackOwned('PostgresCluster', existing);
    const plan = promotionPatch(existing, request);
    if ('error' in plan) throw new ConflictError(plan.error);
    res.json(await k8s.patch({ ...p, spec: plan.spec, dryRun }));
  });

  router.delete('/clusters/:namespace/:name', async (req, res) => {
    await authorize(req, basisClusterDeletePermission);
    const p = params(req);
    assertNotStackOwned('PostgresCluster', await k8s.get(p.namespace, p.name));
    const users = await mcpServersOn(p.namespace, 'cluster', p.name);
    if (users.length) {
      throw new ConflictError(`PostgresCluster ${p.name} is served by MCP server(s) ${users.join(', ')}; delete them first`);
    }
    await k8s.delete(p.namespace, p.name);
    res.status(202).json({ status: 'deleting' });
  });

  return router;
}
