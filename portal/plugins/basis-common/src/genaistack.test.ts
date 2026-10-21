import { allowedStackPromotions, type GenAIStack, stackPromotionPatch, summarizeStack } from './genaistack';

const stack = (spec: GenAIStack['spec'], activeSite: 'protected' | 'recovery' = 'protected'): GenAIStack => ({
  apiVersion: 'ai.cndev.nl/v1alpha1',
  kind: 'GenAIStack',
  metadata: { name: 'bot', namespace: 'ai' },
  spec,
  status: { activeSite },
});

describe('stack switchover', () => {
  it('goes to the other site, either way, once settled', () => {
    expect(allowedStackPromotions(stack({ recovery: { enabled: true } }))).toEqual([
      { site: 'recovery', mode: 'Switchover' },
      { site: 'recovery', mode: 'Failover' },
    ]);
    expect(stackPromotionPatch(stack({ recovery: { enabled: true } }), { site: 'recovery', mode: 'Switchover' })).toEqual({
      spec: { recovery: { activeSite: 'recovery', promotion: 'Switchover' } },
    });
  });

  it('while a switchover waits, only a failover to the same site is left', () => {
    const switching = stack({ recovery: { enabled: true, activeSite: 'recovery', promotion: 'Switchover' } });
    expect(summarizeStack(switching)).toMatchObject({ switching: true, targetSite: 'recovery', activeSite: 'protected' });
    expect(allowedStackPromotions(switching)).toEqual([{ site: 'recovery', mode: 'Failover' }]);
    expect(stackPromotionPatch(switching, { site: 'protected', mode: 'Switchover' })).toHaveProperty('error');
  });

  it('needs recovery', () => {
    expect(allowedStackPromotions(stack({}))).toEqual([]);
    expect(stackPromotionPatch(stack({}), { site: 'recovery', mode: 'Switchover' })).toHaveProperty('error');
  });

  it('names the gateway it uses', () => {
    expect(summarizeStack(stack({})).gatewayName).toBe('bot-gateway');
    expect(summarizeStack(stack({ gateway: { ref: 'llm' } }))).toMatchObject({ gatewayName: 'llm', sharedGateway: true });
    expect(summarizeStack(stack({ gateway: { enabled: false } })).gatewayName).toBeUndefined();
  });
});
