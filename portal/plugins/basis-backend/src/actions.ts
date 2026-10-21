import { BackstageCredentials, PermissionsService } from '@backstage/backend-plugin-api';
import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { NotAllowedError } from '@backstage/errors';
import { AuthorizeResult, BasicPermission } from '@backstage/plugin-permission-common';
import {
  basisGatewayCreatePermission,
  basisGatewayReadPermission,
  basisProjectReadPermission,
  basisStackCreatePermission,
  basisStackReadPermission,
  summarizeGateway,
  summarizeProject,
  summarizeStack,
} from '@internal/backstage-plugin-basis-common';
import { BasisKubernetesService } from './service/BasisKubernetesService';
import { GatewayService } from './service/GatewayService';
import { StackService } from './service/StackService';

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const STACK_NAME = /^[a-z]([-a-z0-9]{0,26}[a-z0-9])?$/;

/**
 * The platform as MCP tools (through @backstage/plugin-mcp-actions-backend),
 * for agents such as Claude Code or Codex: find a project, see what runs in
 * it, and create a GenAI stack or a model gateway. Each action checks the
 * same basis.* permission as the REST API, as the calling user. Creating
 * validates only (dryRun) unless asked otherwise, so an agent can show the
 * plan first. No action hands out credentials: an app mounts the stack's
 * connection Secret in its location, and a person reads keys in the portal.
 */
export function registerActions(options: {
  actionsRegistry: ActionsRegistryService;
  permissions: PermissionsService;
  k8s: Pick<BasisKubernetesService, 'listProjects'>;
  stacks: Pick<StackService, 'list' | 'get' | 'apply'>;
  gateways: Pick<GatewayService, 'list' | 'apply'>;
}) {
  const { actionsRegistry, permissions, k8s, stacks, gateways } = options;
  const authorize = async (credentials: BackstageCredentials, permission: BasicPermission) => {
    const [decision] = await permissions.authorize([{ permission }], { credentials });
    if (decision.result !== AuthorizeResult.ALLOW) throw new NotAllowedError(`Missing permission ${permission.name}`);
  };

  actionsRegistry.register({
    name: 'list-projects',
    title: 'List BASIS projects',
    description:
      'Lists the projects (team namespaces) of the BASIS platform with the locations (Kubernetes clusters) they run in: ' +
      'protected (where workloads run) and recovery (warm standby, optional). Stacks and gateways are created in a project.',
    attributes: { readOnly: true },
    schema: {
      input: z => z.object({}),
      output: z =>
        z.object({
          projects: z.array(
            z.object({
              name: z.string(),
              ready: z.boolean(),
              protectedLocation: z.string().optional(),
              recoveryLocation: z.string().optional(),
              owner: z.string().optional(),
              description: z.string().optional(),
            }),
          ),
        }),
    },
    action: async ({ credentials }) => {
      await authorize(credentials, basisProjectReadPermission);
      const projects = (await k8s.listProjects()).map(p => summarizeProject(p));
      return {
        output: {
          projects: projects.map(p => ({
            name: p.name,
            ready: p.ready,
            protectedLocation: p.protectedLocation,
            recoveryLocation: p.recoveryLocation,
            owner: p.owner,
            description: p.description,
          })),
        },
      };
    },
  });

  actionsRegistry.register({
    name: 'list-genai-stacks',
    title: 'List GenAI stacks',
    description:
      'Lists GenAI stacks (ai.cndev.nl GenAIStack): per stack a RAG database (PostgreSQL + pgvector), a Valkey cache, a model ' +
      'gateway and a connection Secret <name>-connection in its location with DATABASE_URL, VALKEY_URL, OPENAI_BASE_URL and ' +
      'OPENAI_API_KEY. Optionally only one project.',
    attributes: { readOnly: true },
    schema: {
      input: z => z.object({ project: z.string().optional().describe('Only this project') }),
      output: z =>
        z.object({
          stacks: z.array(
            z.object({
              name: z.string(),
              project: z.string(),
              ready: z.boolean(),
              message: z.string().optional(),
              activeSite: z.string(),
              recovery: z.boolean(),
              gateway: z.string().optional(),
              sharedGateway: z.boolean(),
              models: z.array(z.string()),
              cacheMode: z.string().optional(),
              connectionSecret: z.string(),
            }),
          ),
        }),
    },
    action: async ({ input, credentials }) => {
      await authorize(credentials, basisStackReadPermission);
      const items = (await stacks.list(input.project)).map(s => summarizeStack(s));
      return {
        output: {
          stacks: items.map(s => ({
            name: s.name,
            project: s.namespace,
            ready: s.ready,
            message: s.message,
            activeSite: s.activeSite,
            recovery: s.recovery,
            gateway: s.gatewayName,
            sharedGateway: s.sharedGateway,
            models: s.models,
            cacheMode: s.cacheMode,
            connectionSecret: s.connectionSecret,
          })),
        },
      };
    },
  });

  actionsRegistry.register({
    name: 'list-model-gateways',
    title: 'List model gateways',
    description:
      'Lists model gateways (ai.cndev.nl ModelGateway): OpenAI-compatible endpoints to a project\'s hosted and self-hosted ' +
      'models. Clients in the project\'s location call the endpoint with their own key (Secret <name>-keys, key = client name).',
    attributes: { readOnly: true },
    schema: {
      input: z => z.object({ project: z.string().optional().describe('Only this project') }),
      output: z =>
        z.object({
          gateways: z.array(
            z.object({
              name: z.string(),
              project: z.string(),
              ready: z.boolean(),
              endpoint: z.string(),
              models: z.array(z.string()),
              clients: z.array(z.string()),
              keysSecret: z.string(),
              ownedByStack: z.string().optional(),
            }),
          ),
        }),
    },
    action: async ({ input, credentials }) => {
      await authorize(credentials, basisGatewayReadPermission);
      const items = (await gateways.list(input.project)).map(g => summarizeGateway(g));
      return {
        output: {
          gateways: items.map(g => ({
            name: g.name,
            project: g.namespace,
            ready: g.ready,
            endpoint: g.endpoint,
            models: g.models,
            clients: g.clients,
            keysSecret: g.keysSecret,
            ownedByStack: g.stack,
          })),
        },
      };
    },
  });

  const modelSchema = (z: any) =>
    z.object({
      name: z.string().describe('What clients send as "model"'),
      endpoint: z.string().describe('Base URL of the provider API, e.g. https://api.anthropic.com/v1 or http://vllm.models.svc:8000/v1'),
      schema: z.enum(['OpenAI', 'Anthropic']).optional().describe('OpenAI (default; also every OpenAI-compatible server) or Anthropic'),
      upstreamModel: z.string().optional().describe('The model name at the provider, when it differs'),
      apiKeySecret: z.string().optional().describe('Secret in the project holding the provider key under "apiKey"'),
    });
  const toModels = (models?: Array<Record<string, any>>) =>
    (models ?? []).map(({ apiKeySecret, ...m }) => (apiKeySecret ? { ...m, apiKeySecretRef: { name: apiKeySecret } } : m));

  actionsRegistry.register({
    name: 'create-genai-stack',
    title: 'Create a GenAI stack',
    description:
      'Creates a GenAI stack in a project: RAG database, cache, gateway and wiring. Validates only (dryRun: true, the default) ' +
      'unless dryRun is false: show the user the plan first. Either list models for the stack\'s own gateway, or name a shared ' +
      'ModelGateway (gatewayRef) that has a client named after the stack. Apps then mount Secret <name>-connection.',
    attributes: { destructive: false, idempotent: false },
    schema: {
      input: z =>
        z.object({
          project: z.string().describe('Project (namespace) to create it in'),
          name: z.string().regex(STACK_NAME).describe('Stack name: lowercase letters, digits and "-", max 28 characters'),
          dryRun: z.boolean().default(true).describe('Only validate (default); false creates it'),
          recovery: z.boolean().optional().describe('Warm standby in the project\'s recovery location'),
          cacheMode: z.enum(['semantic', 'exact', 'none']).optional().describe('Cache: semantic (default), exact or none'),
          databaseSize: z.string().optional().describe('A size from the postgres-sizes catalog, e.g. s or m'),
          gatewayRef: z.string().optional().describe('A shared ModelGateway in the project to use instead of an own gateway'),
          models: z.array(modelSchema(z)).optional().describe('Models of the stack\'s own gateway'),
          owner: z.string().optional().describe('Owning group'),
        }),
      output: z => z.object({ created: z.boolean(), name: z.string(), project: z.string(), connectionSecret: z.string(), portalPath: z.string() }),
    },
    action: async ({ input, credentials, logger }) => {
      await authorize(credentials, basisStackCreatePermission);
      const spec: Record<string, unknown> = {
        recovery: { enabled: Boolean(input.recovery) },
        cache: input.cacheMode === 'none' ? { enabled: false } : { mode: input.cacheMode ?? 'semantic' },
        retrieval: input.databaseSize ? { size: input.databaseSize } : {},
        gateway: input.gatewayRef ? { ref: input.gatewayRef } : { models: toModels(input.models) },
      };
      await stacks.apply({
        namespace: input.project,
        name: input.name,
        spec,
        labels: input.owner ? { 'backstage.io/owner': input.owner } : undefined,
        createOnly: true,
        dryRun: input.dryRun,
      });
      if (!input.dryRun) logger.info(`Created GenAIStack ${input.project}/${input.name} for an MCP client`);
      return {
        output: {
          created: !input.dryRun,
          name: input.name,
          project: input.project,
          connectionSecret: `${input.name}-connection`,
          portalPath: `/basis/stacks/${input.project}/${input.name}`,
        },
      };
    },
  });

  actionsRegistry.register({
    name: 'create-model-gateway',
    title: 'Create a model gateway',
    description:
      'Creates a ModelGateway in a project: one OpenAI-compatible endpoint (http://<name>.<project>.svc/v1) to hosted and ' +
      'self-hosted models, with a key per client. Validates only (dryRun: true, the default) unless dryRun is false. Provider ' +
      'keys must already be in Secrets in the project.',
    attributes: { destructive: false, idempotent: false },
    schema: {
      input: z =>
        z.object({
          project: z.string().describe('Project (namespace) to create it in'),
          name: z.string().regex(NAME).describe('Gateway name: lowercase letters, digits and "-", max 40 characters'),
          dryRun: z.boolean().default(true).describe('Only validate (default); false creates it'),
          clients: z.array(z.string()).optional().describe('Client names, each gets its own key (default: apps)'),
          models: z.array(modelSchema(z)).describe('Models to route to'),
          recovery: z.boolean().optional().describe('A standby in the project\'s recovery location'),
          owner: z.string().optional().describe('Owning group'),
        }),
      output: z => z.object({ created: z.boolean(), name: z.string(), project: z.string(), endpoint: z.string(), keysSecret: z.string() }),
    },
    action: async ({ input, credentials, logger }) => {
      await authorize(credentials, basisGatewayCreatePermission);
      await gateways.apply({
        namespace: input.project,
        name: input.name,
        spec: {
          recovery: { enabled: Boolean(input.recovery) },
          ...(input.clients?.length ? { clients: input.clients.map(name => ({ name })) } : {}),
          models: toModels(input.models),
        },
        labels: input.owner ? { 'backstage.io/owner': input.owner } : undefined,
        createOnly: true,
        dryRun: input.dryRun,
      });
      if (!input.dryRun) logger.info(`Created ModelGateway ${input.project}/${input.name} for an MCP client`);
      return {
        output: {
          created: !input.dryRun,
          name: input.name,
          project: input.project,
          endpoint: `http://${input.name}.${input.project}.svc/v1`,
          keysSecret: `${input.name}-keys`,
        },
      };
    },
  });
}
