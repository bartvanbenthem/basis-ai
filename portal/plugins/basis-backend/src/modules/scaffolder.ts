import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import {
  BasisKubernetesService,
  basisKubernetesServiceRef,
} from '../service/BasisKubernetesService';
import { GatewayService, gatewayServiceRef } from '../service/GatewayService';
import { StackService, stackServiceRef } from '../service/StackService';
import { ValkeyService, valkeyServiceRef } from '../service/ValkeyService';

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
 * `basis:postgrescluster:create` -- applies a PostgresCluster from a
 * Software Template. The Template itself is the permission boundary (who may
 * run it), the API server validates `spec` against the XRD.
 */
export function createPostgresClusterAction(k8s: BasisKubernetesService) {
  return createTemplateAction({
    id: 'basis:postgrescluster:create',
    description:
      'Creates a CloudNativePG PostgresCluster (postgres.cndev.nl/v1alpha1) through the Crossplane API',
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
      ctx.output('portalPath', `/basis/${namespace}/${name}`);
    },
  });
}

/**
 * `basis:project:create` -- applies a Project (platform.cndev.nl/v1alpha1): a
 * namespace with its own Prometheus and Grafana that PostgresClusters can
 * then be created in.
 */
export function createProjectAction(k8s: BasisKubernetesService) {
  return createTemplateAction({
    id: 'basis:project:create',
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
      ctx.output('portalPath', `/basis/projects/${name}`);
    },
  });
}

/**
 * `basis:valkeycache:create` -- applies a ValkeyCache (cache.cndev.nl/v1alpha1)
 * from a Software Template: an exact or semantic Valkey cache in the project's
 * location. The API server validates `spec` against the XRD.
 */
export function createValkeyCacheAction(valkey: Pick<ValkeyService, 'apply'>) {
  return createTemplateAction({
    id: 'basis:valkeycache:create',
    description: 'Creates a Valkey cache (cache.cndev.nl/v1alpha1 ValkeyCache) through the Crossplane API',
    supportsDryRun: true,
    schema: {
      input: {
        name: z => z.string().regex(/^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/).describe('Cache name'),
        namespace: z =>
          z
            .string()
            .describe(
              'Kubernetes namespace, or the entity ref of a project (resource:default/<project>) from an EntityPicker',
            ),
        owner: z => z.string().optional().describe('Owning group (backstage.io/owner label)'),
        system: z => z.string().optional().describe('Backstage system (backstage.io/system label)'),
        spec: z => z.record(z.unknown()).describe('ValkeyCache spec'),
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

      ctx.logger.info(`Applying ValkeyCache ${namespace}/${name}`);
      await valkey.apply({
        name,
        namespace,
        spec: (prune(spec) ?? {}) as Record<string, unknown>,
        labels,
        createOnly: true,
        dryRun: ctx.isDryRun,
      });

      ctx.output('name', name);
      ctx.output('namespace', namespace);
      ctx.output('entityRef', `resource:default/${namespace}--${name}.valkey`.slice(0, 80));
      ctx.output('portalPath', `/basis/caches/${namespace}/${name}`);
    },
  });
}

/** A template's model rows (secretName) as the XRD's models (apiKeySecretRef). */
export function modelRefs(models: unknown): unknown {
  if (!Array.isArray(models)) return models;
  return models.map(({ secretName, ...m }: Record<string, any>) =>
    secretName ? { ...m, apiKeySecretRef: { name: secretName } } : m,
  );
}

/** A stack template's spec with its gateway's model rows as the XRD's models. */
export function stackModels(spec: Record<string, any>): Record<string, any> {
  if (!Array.isArray(spec.gateway?.models)) return spec;
  return { ...spec, gateway: { ...spec.gateway, models: modelRefs(spec.gateway.models) } };
}

/**
 * `basis:genaistack:create` -- applies a GenAIStack (ai.cndev.nl/v1alpha1) from a
 * Software Template: retrieval, cache, gateway and wiring in the project's
 * site(s). The API server validates `spec` against the XRD.
 */
export function createGenAIStackAction(stacks: Pick<StackService, 'apply'>) {
  return createTemplateAction({
    id: 'basis:genaistack:create',
    description: 'Creates a GenAI stack (ai.cndev.nl/v1alpha1 GenAIStack) through the Crossplane API',
    supportsDryRun: true,
    schema: {
      input: {
        name: z => z.string().regex(/^[a-z]([-a-z0-9]{0,26}[a-z0-9])?$/).describe('Stack name'),
        namespace: z =>
          z.string().describe('Kubernetes namespace, or the entity ref of a project (resource:default/<project>)'),
        owner: z => z.string().optional().describe('Owning group (backstage.io/owner label)'),
        system: z => z.string().optional().describe('Backstage system (backstage.io/system label)'),
        spec: z => z.record(z.unknown()).describe('GenAIStack spec'),
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
      const namespace = ctx.input.namespace.replace(/^.*[:/]/, '');
      const labels: Record<string, string> = {};
      if (owner) labels['backstage.io/owner'] = owner.replace(/^.*[:/]/, '');
      if (system) labels['backstage.io/system'] = system.replace(/^.*[:/]/, '');

      ctx.logger.info(`Applying GenAIStack ${namespace}/${name}`);
      await stacks.apply({
        name,
        namespace,
        spec: stackModels((prune(spec) ?? {}) as Record<string, any>),
        labels,
        createOnly: true,
        dryRun: ctx.isDryRun,
      });

      ctx.output('name', name);
      ctx.output('namespace', namespace);
      ctx.output('entityRef', `resource:default/${namespace}--${name}.stack`.slice(0, 80));
      ctx.output('portalPath', `/basis/stacks/${namespace}/${name}`);
    },
  });
}

/**
 * `basis:modelgateway:create` -- applies a ModelGateway (ai.cndev.nl/v1alpha1)
 * from a Software Template: an OpenAI-compatible endpoint to a project's
 * models with a key per client. The API server validates `spec` against the XRD.
 */
export function createModelGatewayAction(gateways: Pick<GatewayService, 'apply'>) {
  return createTemplateAction({
    id: 'basis:modelgateway:create',
    description: 'Creates a model gateway (ai.cndev.nl/v1alpha1 ModelGateway) through the Crossplane API',
    supportsDryRun: true,
    schema: {
      input: {
        name: z => z.string().regex(/^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/).describe('Gateway name'),
        namespace: z =>
          z.string().describe('Kubernetes namespace, or the entity ref of a project (resource:default/<project>)'),
        owner: z => z.string().optional().describe('Owning group (backstage.io/owner label)'),
        system: z => z.string().optional().describe('Backstage system (backstage.io/system label)'),
        spec: z => z.record(z.unknown()).describe('ModelGateway spec'),
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
      const namespace = ctx.input.namespace.replace(/^.*[:/]/, '');
      const labels: Record<string, string> = {};
      if (owner) labels['backstage.io/owner'] = owner.replace(/^.*[:/]/, '');
      if (system) labels['backstage.io/system'] = system.replace(/^.*[:/]/, '');
      const pruned = (prune(spec) ?? {}) as Record<string, any>;

      ctx.logger.info(`Applying ModelGateway ${namespace}/${name}`);
      await gateways.apply({
        name,
        namespace,
        spec: { ...pruned, ...(pruned.models ? { models: modelRefs(pruned.models) } : {}) },
        labels,
        createOnly: true,
        dryRun: ctx.isDryRun,
      });

      ctx.output('name', name);
      ctx.output('namespace', namespace);
      ctx.output('entityRef', `resource:default/${namespace}--${name}.gateway`.slice(0, 80));
      ctx.output('portalPath', `/basis/gateways/${namespace}/${name}`);
    },
  });
}

/**
 * Scaffolder module registering the basis actions.
 *
 * @public
 */
export const scaffolderModuleBasis = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'basis',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        k8s: basisKubernetesServiceRef,
        valkey: valkeyServiceRef,
        stacks: stackServiceRef,
        gateways: gatewayServiceRef,
      },
      async init({ scaffolder, k8s, valkey, stacks, gateways }) {
        scaffolder.addActions(
          createPostgresClusterAction(k8s),
          createProjectAction(k8s),
          createValkeyCacheAction(valkey),
          createModelGatewayAction(gateways),
          createGenAIStackAction(stacks),
        );
      },
    });
  },
});
