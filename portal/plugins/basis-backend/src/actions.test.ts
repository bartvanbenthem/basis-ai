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
  registerActions({
    actionsRegistry: { register: (a: any) => actions.set(a.name, a) },
    permissions: mockServices.permissions.mock({
      authorize: async () => [{ result: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY }],
    }) as any,
    k8s: { listProjects: jest.fn(async () => []) } as any,
    stacks: stacks as any,
    gateways: gateways as any,
  });
  const run = (name: string, input: unknown) => {
    const a = actions.get(name);
    return a.action({ input: a.schema.input(z).parse(input), credentials: mockCredentials.user(), logger: mockServices.logger.mock() });
  };
  return { actions, stacks, gateways, run };
}

describe('MCP actions', () => {
  it('registers the platform tools', () => {
    expect([...setup().actions.keys()].sort()).toEqual([
      'create-genai-stack',
      'create-model-gateway',
      'list-genai-stacks',
      'list-model-gateways',
      'list-projects',
    ]);
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
