import { defaultGatewayForm, fromGateway, toGatewayEditPatch, toGatewaySpec, validateGateway } from './gatewayForm';

describe('gatewayForm', () => {
  const form = {
    ...defaultGatewayForm(),
    name: 'llm',
    namespace: 'demo',
    clients: ['apps', 'coding-agent'],
    models: [
      { name: 'claude', endpoint: 'https://api.anthropic.com/v1', schema: 'Anthropic' as const, upstreamModel: '', secretName: 'anthropic', secretKey: 'apiKey' },
    ],
  };

  it('maps onto the XRD: clients as objects, the key Secret as apiKeySecretRef', () => {
    expect(toGatewaySpec(form)).toEqual({
      replicas: 2,
      recovery: { enabled: false, replicas: 1 },
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
});
