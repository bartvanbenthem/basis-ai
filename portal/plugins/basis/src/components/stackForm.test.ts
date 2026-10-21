import type { GenAIStack } from '@internal/backstage-plugin-basis-common';
import { defaultStackForm, fromStack, toStackEditPatch, toStackSpec, validateStack } from './stackForm';

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
      { name: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1', schema: 'OpenAI', upstreamModel: '', secretName: 'openai', secretKey: 'apiKey' },
      { name: 'llama', endpoint: 'http://vllm.models.svc:8000/v1', schema: 'OpenAI', upstreamModel: 'meta-llama/Llama-3.1-8B-Instruct', secretName: '', secretKey: 'apiKey' },
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
        { name: 'x', endpoint: 'not a url', schema: 'OpenAI', upstreamModel: '', secretName: '', secretKey: 'apiKey' },
        { name: 'x', endpoint: 'https://a.b/v1', schema: 'OpenAI', upstreamModel: '', secretName: '', secretKey: 'apiKey' },
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
});
