import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { z } from 'zod';
import { registerActions } from './actions';

/** Collects the registered actions and runs them the way the registry would. */
function setup(allow = true) {
  const actions = new Map<string, any>();
  const stacks = {
    list: jest.fn(async () => [
      { apiVersion: 'ai.cndev.nl/v1alpha1', kind: 'GenAIStack', metadata: { name: 'bot', namespace: 'demo' }, spec: { gateway: { ref: 'llm' } } },
    ]),
    get: jest.fn(),
    apply: jest.fn(async () => ({})),
  };
  const gateways = { list: jest.fn(async () => []), apply: jest.fn(async () => ({})) };
  const servers = {
    list: jest.fn(async () => [
      {
        apiVersion: 'ai.cndev.nl/v1alpha1',
        kind: 'ModelServer',
        metadata: { name: 'llama', namespace: 'demo' },
        spec: { model: { uri: 'hf://meta-llama/Llama-3.1-8B-Instruct' }, replicas: 2, recovery: { enabled: true } },
      },
    ]),
  };
  const mcp = {
    list: jest.fn(async () => [
      {
        apiVersion: 'ai.cndev.nl/v1alpha1',
        kind: 'MCPServer',
        metadata: { name: 'kb', namespace: 'demo' },
        spec: {
          database: { stack: 'bot' },
          embeddings: { model: 'text-embedding-3-small' },
          clients: [{ name: 'claude-code' }, { name: 'bot', tools: ['search', 'recall'] }, { name: 'old' }],
        },
        status: { expiredClients: ['old'] },
      },
    ]),
    apply: jest.fn(async () => ({})),
  };
  registerActions({
    actionsRegistry: { register: (a: any) => actions.set(a.name, a) },
    permissions: mockServices.permissions.mock({
      authorize: async () => [{ result: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY }],
    }) as any,
    k8s: { listProjects: jest.fn(async () => []) } as any,
    stacks: stacks as any,
    gateways: gateways as any,
    servers: servers as any,
    mcp: mcp as any,
  });
  const run = (name: string, input: unknown) => {
    const a = actions.get(name);
    return a.action({ input: a.schema.input(z).parse(input), credentials: mockCredentials.user(), logger: mockServices.logger.mock() });
  };
  return { actions, stacks, gateways, servers, mcp, run };
}

describe('MCP actions', () => {
  it('registers the platform tools', () => {
    expect([...setup().actions.keys()].sort()).toEqual([
      'create-genai-stack',
      'create-mcp-server',
      'create-model-gateway',
      'list-genai-stacks',
      'list-mcp-servers',
      'list-model-gateways',
      'list-model-servers',
      'list-projects',
    ]);
  });

  it('lists MCP servers with each client\'s tools, not the expired ones', async () => {
    const { output } = await setup().run('list-mcp-servers', { project: 'demo' });
    expect(output.servers[0]).toEqual({
      name: 'kb',
      project: 'demo',
      ready: false,
      endpoint: 'http://kb.demo.svc/mcp',
      database: 'GenAIStack/bot',
      tools: ['search', 'fetch', 'remember', 'recall', 'forget'],
      clients: [
        { name: 'claude-code', tools: ['search', 'fetch', 'remember', 'recall', 'forget'] },
        { name: 'bot', tools: ['search', 'recall'] },
      ],
      search: 'hybrid',
      memoryScope: 'client',
      keysSecret: 'kb-keys',
    });
  });

  it('creates an MCP server over a stack, a dry run unless asked', async () => {
    const { run, mcp } = setup();
    const { output } = await run('create-mcp-server', {
      project: 'demo',
      name: 'kb',
      stack: 'bot',
      embeddingsModel: 'text-embedding-3-small',
      sharedMemory: true,
      clients: [{ name: 'bot', tools: ['search'] }],
    });
    expect(output).toEqual({
      created: false,
      name: 'kb',
      project: 'demo',
      endpoint: 'http://kb.demo.svc/mcp',
      keysSecret: 'kb-keys',
      portalPath: '/basis/mcp-servers/demo/kb',
    });
    expect(mcp.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        createOnly: true,
        spec: {
          database: { stack: 'bot' },
          recovery: { enabled: false },
          retrieval: { ingest: false },
          memory: { enabled: true, scope: 'shared' },
          embeddings: { model: 'text-embedding-3-small' },
          clients: [{ name: 'bot', tools: ['search'] }],
        },
      }),
    );
  });

  it('refuses MCP servers without the permission', async () => {
    await expect(setup(false).run('list-mcp-servers', {})).rejects.toThrow('basis.mcp.read');
    await expect(setup(false).run('create-mcp-server', { project: 'demo', name: 'kb', stack: 'bot' })).rejects.toThrow('basis.mcp.create');
  });

  it('lists model servers with the name to give their gateway models', async () => {
    const { output } = await setup().run('list-model-servers', {});
    expect(output.servers[0]).toEqual({
      name: 'llama',
      project: 'demo',
      ready: false,
      model: 'llama',
      uri: 'hf://meta-llama/Llama-3.1-8B-Instruct',
      replicas: 2,
      gpus: 1,
      sites: ['protected', 'recovery'],
    });
  });

  it('a gateway model on a model server', async () => {
    const { run, gateways } = setup();
    await run('create-model-gateway', { project: 'demo', name: 'llm', models: [{ name: 'llama', server: 'llama' }] });
    expect(gateways.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ models: [{ name: 'llama', server: 'llama' }] }) }),
    );
  });

  it('lists stacks with the gateway they use', async () => {
    const { output } = await setup().run('list-genai-stacks', {});
    expect(output.stacks[0]).toMatchObject({ name: 'bot', project: 'demo', gateway: 'llm', sharedGateway: true, connectionSecret: 'bot-connection' });
  });

  it('creating validates only, unless asked to create', async () => {
    const { run, stacks } = setup();
    const plan = await run('create-genai-stack', { project: 'demo', name: 'bot', gatewayRef: 'llm' });
    expect(plan.output.created).toBe(false);
    expect(stacks.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ dryRun: true, createOnly: true, spec: expect.objectContaining({ gateway: { ref: 'llm' } }) }),
    );
    await run('create-genai-stack', { project: 'demo', name: 'bot', dryRun: false, models: [{ name: 'm', endpoint: 'http://x/v1', apiKeySecret: 'k' }] });
    expect(stacks.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dryRun: false,
        spec: expect.objectContaining({ gateway: { models: [{ name: 'm', endpoint: 'http://x/v1', apiKeySecretRef: { name: 'k' } }] } }),
      }),
    );
  });

  it('checks the caller\'s permissions', async () => {
    const { run, gateways } = setup(false);
    await expect(run('create-model-gateway', { project: 'demo', name: 'llm', models: [] })).rejects.toThrow('basis.gateway.create');
    expect(gateways.apply).not.toHaveBeenCalled();
  });
});
