import type { GenAIStack } from '@internal/backstage-plugin-basis-common';
import { defaultStackForm, emptyModel, fromStack, toStackEditPatch, toStackSpec, validateStack } from './stackForm';

const stack: GenAIStack = {
  apiVersion: 'ai.cndev.nl/v1alpha1',
  kind: 'GenAIStack',
  metadata: { name: 'support-bot', namespace: 'demo', labels: { 'backstage.io/owner': 'team-ai' } },
  spec: {
    recovery: { enabled: true },
    retrieval: { size: 'm', extensions: ['vector', 'vchord'] },
    gateway: {
      models: [
        { name: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1', apiKeySecretRef: { name: 'openai' } },
        { name: 'llama', endpoint: 'http://vllm.models.svc:8000/v1', upstreamModel: 'meta-llama/Llama-3.1-8B-Instruct' },
      ],
    },
  },
};

describe('stackForm', () => {
  it('starts as a single-site stack with a semantic cache and the gateway', () => {
    const spec = toStackSpec({ ...defaultStackForm(), name: 'bot', namespace: 'demo', models: [] });
    expect(spec).toMatchObject({
      recovery: { enabled: false },
      retrieval: { extensions: ['vector'], storageSize: '20Gi' },
      cache: { enabled: true, mode: 'semantic' },
      gateway: { enabled: true, models: [] },
    });
    expect((spec.retrieval as any).size).toBeUndefined();
  });

  it('maps models, with an API key Secret only when named', () => {
    const f = fromStack(stack);
    expect(f.models).toEqual([
      { ...emptyModel(), name: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1', keySource: 'secret', secretName: 'openai' },
      { ...emptyModel(), name: 'llama', endpoint: 'http://vllm.models.svc:8000/v1', upstreamModel: 'meta-llama/Llama-3.1-8B-Instruct', keySource: 'none' },
    ]);
    const models = (toStackSpec(f).gateway as any).models;
    expect(models[0].apiKeySecretRef).toEqual({ name: 'openai', key: 'apiKey' });
    expect(models[1].apiKeySecretRef).toBeUndefined();
    expect(models[1].upstreamModel).toBe('meta-llama/Llama-3.1-8B-Instruct');
  });

  it('flags invalid input, per model row', () => {
    const e = validateStack({
      ...defaultStackForm(),
      name: 'a-name-that-is-far-too-long-for-a-stack',
      models: [
        { ...emptyModel(), name: 'x', endpoint: 'not a url', keySource: 'none' },
        { ...emptyModel(), name: 'x', endpoint: 'https://a.b/v1', keySource: 'none' },
      ],
    });
    expect(e.name).toMatch(/28/);
    expect(e.namespace).toBeDefined();
    expect(e.modelRows).toEqual({ 0: expect.stringMatching(/URL/), 1: expect.stringMatching(/twice/) });
    expect(validateStack({ ...fromStack(stack) })).toEqual({});
  });

  it('patches only what changed; the models list as a whole', () => {
    const original = fromStack(stack);
    expect(toStackEditPatch(original, original)).toEqual({});
    expect(toStackEditPatch(original, { ...original, cacheMemory: '2Gi' })).toEqual({ cache: { memory: '2Gi' } });
    const fewer = toStackEditPatch(original, { ...original, models: original.models.slice(0, 1) });
    expect((fewer.gateway as any).models).toHaveLength(1);
  });

  it('exposes the database (CIDRs) and its own gateway (hostname and CIDRs), internal by default', () => {
    const f = fromStack(stack);
    expect((toStackSpec(f).retrieval as any).expose).toBeUndefined();
    expect((toStackSpec(f).gateway as any).expose).toBeUndefined();
    const on = { ...f, dbExpose: { ...f.dbExpose, enabled: true }, gatewayExpose: { ...f.gatewayExpose, enabled: true } };
    const e = validateStack(on);
    expect(e.dbExposeSourceRanges).toMatch(/CIDRs/);
    expect(e.gatewayExposeHostname).toMatch(/DNS name/);
    const ok = {
      ...on,
      dbExpose: { ...on.dbExpose, sourceRanges: '203.0.113.10/32' },
      gatewayExpose: { ...on.gatewayExpose, hostname: 'bot.example.com', sourceRanges: '0.0.0.0/0' },
    };
    expect(validateStack(ok)).toEqual({});
    expect(toStackEditPatch(f, ok)).toEqual({
      retrieval: { expose: { enabled: true, loadBalancerSourceRanges: ['203.0.113.10/32'] } },
      gateway: { expose: { enabled: true, hostname: 'bot.example.com', loadBalancerSourceRanges: ['0.0.0.0/0'] } },
    });
    // A shared gateway's exposure is the gateway's own.
    const shared = toStackSpec({ ...ok, gatewayRef: 'llm' });
    expect((shared.gateway as any).expose).toBeUndefined();
    expect(validateStack({ ...on, dbExpose: ok.dbExpose, gatewayRef: 'llm' })).toEqual({});
  });
});
