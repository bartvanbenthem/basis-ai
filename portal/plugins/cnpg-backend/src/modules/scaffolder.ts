import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import {
  CnpgKubernetesService,
  cnpgKubernetesServiceRef,
} from '../service/CnpgKubernetesService';

/**
 * Drops empty strings, nulls and objects left empty by that, so templates can
 * pass optional form fields through unconditionally (an unset
 * `backup.destinationPath` must be absent, not "", to pass the XRD schema).
 */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(prune).filter(v => v !== undefined);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, prune(v)] as const)
      .filter(([, v]) => v !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === '' || value === null || value === undefined ? undefined : value;
}

/**
 * `cnpg:postgrescluster:create` -- applies a PostgresCluster from a
 * Software Template. The Template itself is the permission boundary (who may
 * run it), the API server validates `spec` against the XRD.
 */
export function createPostgresClusterAction(k8s: CnpgKubernetesService) {
  return createTemplateAction({
    id: 'cnpg:postgrescluster:create',
    description:
      'Creates a CloudNativePG PostgresCluster (cnpg.cndev.nl/v1alpha1) through the Crossplane API',
    supportsDryRun: true,
    schema: {
      input: {
        name: z => z.string().regex(/^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/).describe('Cluster name'),
        namespace: z =>
          z
            .string()
            .describe(
              'Kubernetes namespace, or the entity ref of a project (resource:default/<project>) from an EntityPicker',
            ),
        owner: z => z.string().optional().describe('Owning group (backstage.io/owner label)'),
        system: z => z.string().optional().describe('Backstage system (backstage.io/system label)'),
        spec: z => z.record(z.unknown()).describe('PostgresCluster spec'),
      },
      output: {
        name: z => z.string(),
        namespace: z => z.string(),
        entityRef: z => z.string(),
        portalPath: z => z.string(),
      },
    },
    async handler(ctx) {
      const { name, owner, system, spec } = ctx.input;
      // A project entity is named after its namespace.
      const namespace = ctx.input.namespace.replace(/^.*[:/]/, '');
      const labels: Record<string, string> = {};
      // Label values cannot hold "group:default/x"; store the bare name.
      if (owner) labels['backstage.io/owner'] = owner.replace(/^.*[:/]/, '');
      if (system) labels['backstage.io/system'] = system.replace(/^.*[:/]/, '');

      ctx.logger.info(`Applying PostgresCluster ${namespace}/${name}`);
      await k8s.apply({
        name,
        namespace,
        spec: (prune(spec) ?? {}) as Record<string, unknown>,
        labels,
        createOnly: true,
        dryRun: ctx.isDryRun,
      });

      ctx.output('name', name);
      ctx.output('namespace', namespace);
      ctx.output('entityRef', `resource:default/${namespace}--${name}`.slice(0, 80));
      ctx.output('portalPath', `/cnpg/${namespace}/${name}`);
    },
  });
}

/**
 * `cnpg:project:create` -- applies a Project (platform.cndev.nl/v1alpha1): a
 * namespace with its own Prometheus and Grafana that PostgresClusters can
 * then be created in.
 */
export function createProjectAction(k8s: CnpgKubernetesService) {
  return createTemplateAction({
    id: 'cnpg:project:create',
    description:
      'Creates a Project (platform.cndev.nl/v1alpha1): a namespace with its own Prometheus and Grafana',
    supportsDryRun: true,
    schema: {
      input: {
        name: z =>
          z
            .string()
            .regex(/^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/)
            .refine(v => !v.includes('--'), 'must not contain "--"')
            .describe('Project name, also the namespace name'),
        owner: z => z.string().optional().describe('Owning group (spec.owner and backstage.io/owner label)'),
        description: z => z.string().optional(),
        spec: z =>
          z
            .record(z.unknown())
            .optional()
            .describe('Further Project spec: locations (protected, recovery), access, quota, observability'),
      },
      output: {
        name: z => z.string(),
        namespace: z => z.string(),
        entityRef: z => z.string(),
        portalPath: z => z.string(),
      },
    },
    async handler(ctx) {
      const { name, description, spec } = ctx.input;
      // Label values cannot hold "group:default/x"; store the bare name.
      const owner = ctx.input.owner?.replace(/^.*[:/]/, '');

      ctx.logger.info(`Applying Project ${name}`);
      await k8s.applyProject({
        name,
        spec: (prune({ ...spec, owner, description }) ?? {}) as Record<string, unknown>,
        labels: owner ? { 'backstage.io/owner': owner } : undefined,
        createOnly: true,
        dryRun: ctx.isDryRun,
      });

      ctx.output('name', name);
      ctx.output('namespace', name);
      ctx.output('entityRef', `resource:default/${name}`);
      ctx.output('portalPath', `/cnpg/projects/${name}`);
    },
  });
}

/**
 * Scaffolder module registering the cnpg actions.
 *
 * @public
 */
export const scaffolderModuleCnpg = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'cnpg',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        k8s: cnpgKubernetesServiceRef,
      },
      async init({ scaffolder, k8s }) {
        scaffolder.addActions(createPostgresClusterAction(k8s), createProjectAction(k8s));
      },
    });
  },
});
