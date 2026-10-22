import { providerKeySecretName } from '@internal/backstage-plugin-basis-common';
import {
  defaultGatewayForm,
  fromGateway,
  gatewayProviderKeys,
  toGatewayEditPatch,
  toGatewaySpec,
  validateGateway,
} from './gatewayForm';

describe('gatewayForm', () => {
  const form = {
    ...defaultGatewayForm(),
    name: 'llm',
    namespace: 'demo',
    clients: ['apps', 'coding-agent'],
    models: [
      {
        name: 'claude',
        endpoint: 'https://api.anthropic.com/v1',
        schema: 'Anthropic' as const,
        upstreamModel: '',
        keySource: 'secret' as const,
        apiKey: '',
        secretName: 'anthropic',
        secretKey: 'apiKey',
      },
    ],
  };

  it('maps onto the XRD: clients as objects, the key Secret as apiKeySecretRef', () => {
    expect(toGatewaySpec(form)).toEqual({
      replicas: 2,
      recovery: { enabled: false, replicas: 1 },
      retry: { attempts: 2 },
      clients: [{ name: 'apps' }, { name: 'coding-agent' }],
      models: [{ name: 'claude', endpoint: 'https://api.anthropic.com/v1', schema: 'Anthropic', apiKeySecretRef: { name: 'anthropic', key: 'apiKey' } }],
    });
  });

  it('flags bad and duplicate clients and model rows', () => {
    expect(validateGateway({ ...form, clients: ['Apps'] }).clients).toContain('Apps');
    expect(validateGateway({ ...form, clients: ['a', 'a'] }).clients).toContain('twice');
    expect(validateGateway({ ...form, models: [{ ...form.models[0], endpoint: 'nope' }] }).modelRows?.[0]).toContain('URL');
    expect(validateGateway(form)).toEqual({});
  });

  it('edits replace the clients list as a whole', () => {
    const original = fromGateway({
      apiVersion: 'ai.cndev.nl/v1alpha1',
      kind: 'ModelGateway',
      metadata: { name: 'llm', namespace: 'demo' },
      spec: { clients: [{ name: 'apps' }], models: [] },
    });
    expect(toGatewayEditPatch(original, { ...original, clients: ['apps', 'bot'] })).toEqual({
      clients: [{ name: 'apps' }, { name: 'bot' }],
    });
  });

  it('a key entered in the form goes to a Secret the spec references, never into the spec', () => {
    const entered = { ...form, models: [{ ...form.models[0], keySource: 'enter' as const, apiKey: 'sk-secret' }] };
    const spec = toGatewaySpec(entered) as { models: Array<Record<string, unknown>> };
    expect(spec.models[0].apiKeySecretRef).toEqual({ name: providerKeySecretName('llm', 'claude'), key: 'apiKey' });
    expect(JSON.stringify(spec)).not.toContain('sk-secret');
    expect(gatewayProviderKeys(entered)).toEqual({ claude: 'sk-secret' });
    // Pasted from a wrapped display: the line breaks aren't part of the token.
    const wrapped = { ...entered, models: [{ ...entered.models[0], apiKey: ' eyJh.abc \n def.ghi\n' }] };
    expect(gatewayProviderKeys(wrapped)).toEqual({ claude: 'eyJh.abcdef.ghi' });
    expect(validateGateway({ ...entered, models: [{ ...entered.models[0], apiKey: '' }] }).modelRows?.[0]).toContain('API key');
  });

  it('a stored key shows as stored, a token typed as the key name is caught', () => {
    const gw = fromGateway({
      apiVersion: 'ai.cndev.nl/v1alpha1',
      kind: 'ModelGateway',
      metadata: { name: 'llm', namespace: 'demo' },
      spec: { models: [{ name: 'claude', endpoint: 'https://x/v1', apiKeySecretRef: { name: providerKeySecretName('llm', 'claude') } }] },
    });
    expect(gw.models[0].keySource).toBe('stored');
    expect(gatewayProviderKeys(gw)).toBeUndefined();
    const typo = { ...form, models: [{ ...form.models[0], secretKey: `eyJhbGciOiJSUzUxMiIs.${'x'.repeat(80)}.u6zq` }] };
    expect(validateGateway(typo).modelRows?.[0]).toContain('not the token');
  });

  it('exposes over HTTPS only with a hostname and client CIDRs, keeping what the form does not show', () => {
    expect(toGatewaySpec(form).expose).toBeUndefined();
    const on = { ...form, expose: { ...form.expose, enabled: true } };
    expect(validateGateway(on).exposeHostname).toMatch(/DNS name/);
    expect(validateGateway(on).exposeSourceRanges).toMatch(/CIDRs/);
    const ok = { ...on, expose: { ...on.expose, hostname: 'llm.example.com', sourceRanges: '0.0.0.0/0' } };
    expect(validateGateway(ok).exposeHostname).toBeUndefined();
    expect(validateGateway(ok).exposeSourceRanges).toBeUndefined();
    expect(toGatewaySpec(ok).expose).toEqual({ enabled: true, hostname: 'llm.example.com', loadBalancerSourceRanges: ['0.0.0.0/0'] });

    const gw = fromGateway({
      apiVersion: 'ai.cndev.nl/v1alpha1',
      kind: 'ModelGateway',
      metadata: { name: 'llm', namespace: 'demo' },
      spec: { expose: { enabled: true, hostname: 'llm.example.com', issuer: 'acme', loadBalancerSourceRanges: ['10.0.0.0/8'] } },
    });
    expect(toGatewayEditPatch(gw, { ...gw, expose: { ...gw.expose, sourceRanges: '10.0.0.0/8, 192.0.2.0/24' } })).toEqual({
      expose: { loadBalancerSourceRanges: ['10.0.0.0/8', '192.0.2.0/24'] },
    });
    // Turning it off removes it: back to the XRD default (internal).
    expect(toGatewayEditPatch(gw, { ...gw, expose: { ...gw.expose, enabled: false } })).toEqual({ expose: null });
  });

  it('caps tokens per client and for the gateway, and lets keys expire', () => {
    const f = {
      ...form,
      monthlyTokens: '10000000',
      clientSettings: { apps: { owner: 'team-ai', monthlyTokens: '1000000', expiresAt: '2026-12-31' } },
    };
    const spec = toGatewaySpec(f) as { clients: unknown[]; monthlyTokens: number };
    expect(spec.monthlyTokens).toBe(10_000_000);
    expect(spec.clients).toEqual([
      { name: 'apps', owner: 'team-ai', monthlyTokens: 1_000_000, expiresAt: '2026-12-31' },
      { name: 'coding-agent' },
    ]);
    expect(validateGateway({ ...f, clientSettings: { apps: { owner: '', monthlyTokens: '1e6', expiresAt: '' } } }).clientSettings).toContain(
      'apps',
    );
    // Read back from the spec.
    const back = fromGateway({
      apiVersion: 'ai.cndev.nl/v1alpha1', kind: 'ModelGateway', metadata: { name: 'llm', namespace: 'demo' },
      spec: { clients: [{ name: 'apps', monthlyTokens: 5 }], monthlyTokens: 9 },
    });
    expect(back.clientSettings.apps.monthlyTokens).toBe('5');
    expect(back.monthlyTokens).toBe('9');
  });

  it('retries, falls back and caps requests per minute', () => {
    const f = {
      ...form,
      retryAttempts: 3,
      requestsPerMinute: '600',
      clientSettings: { apps: { owner: '', monthlyTokens: '', expiresAt: '', tokensPerMinute: '20000' } },
      models: [
        { ...form.models[0], fallbacks: 'llama' },
        { ...form.models[0], name: 'llama', endpoint: 'http://vllm.models.svc:8000/v1', keySource: 'none' as const },
      ],
    };
    const spec = toGatewaySpec(f) as Record<string, any>;
    expect(spec.retry).toEqual({ attempts: 3 });
    expect(spec.rateLimit).toEqual({ requestsPerMinute: 600 });
    expect(spec.clients[0]).toEqual({ name: 'apps', tokensPerMinute: 20000 });
    expect(spec.models[0].fallbacks).toEqual(['llama']);
    expect(validateGateway({ ...f, models: [{ ...f.models[0], fallbacks: 'nope' }, f.models[1]] }).modelRows?.[0]).toContain('Fallback nope');
    // An unchanged gateway patches nothing, though its spec had no retry.
    const back = fromGateway({
      apiVersion: 'ai.cndev.nl/v1alpha1', kind: 'ModelGateway', metadata: { name: 'llm', namespace: 'demo' },
      spec: { models: [{ name: 'a', endpoint: 'https://x/v1', fallbacks: ['b'] }, { name: 'b', endpoint: 'https://y/v1' }] },
    });
    expect(back.retryAttempts).toBe(2);
    expect(back.models[0].fallbacks).toBe('b');
  });
});
