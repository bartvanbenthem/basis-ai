import type { Project } from '@internal/backstage-plugin-basis-common';
import { CostService, type Query } from './CostService';

const project = (governance?: object): Project => ({
  apiVersion: 'platform.cndev.nl/v1alpha1',
  kind: 'Project',
  metadata: { name: 'demo' },
  spec: { locations: { protected: 'dc-a' }, budget: { monthly: 500, monthlyTokens: 1_000_000 } },
  status: { prometheus: { url: 'http://prometheus-operated.demo.svc:9090' }, governance },
});

/** Answers each query by the series it asks for. */
const query: Query = async (_url, promql) => {
  if (promql.startsWith('basis:cost_monthly_forecast')) return [{ metric: {}, value: 412.345 }];
  if (promql.startsWith('sum_over_time')) return [{ metric: {}, value: 96.1 }];
  if (promql.startsWith('sum by (component, site)')) {
    return [
      { metric: { component: 'cpu', site: 'protected' }, value: 0.1 },
      { metric: { component: 'tokens', site: 'protected' }, value: 0.2 },
    ];
  }
  if (promql.startsWith('basis:tokens_monthly_forecast')) return [{ metric: {}, value: 730000.4 }];
  if (promql.startsWith('sum by (gen_ai_request_model, gen_ai_token_type)')) {
    return [
      { metric: { gen_ai_request_model: 'openai/gpt-oss-120b', gen_ai_token_type: 'input' }, value: 600 },
      { metric: { gen_ai_request_model: 'openai/gpt-oss-120b', gen_ai_token_type: 'output' }, value: 400 },
    ];
  }
  if (promql.startsWith('sum by (gen_ai_request_model)')) return [{ metric: { gen_ai_request_model: 'openai/gpt-oss-120b' }, value: 0.2 }];
  return [];
};

describe('CostService', () => {
  it("reads the project's cost rules: forecast, breakdown per month, tokens per model", async () => {
    const urls: string[] = [];
    const service = new CostService({
      getProject: async () => project({ currency: 'EUR', costMetric: 'basis:cost_per_hour' }),
      query: async (url, promql) => {
        urls.push(url);
        return query(url, promql);
      },
    });
    const cost = await service.get('demo');
    expect(cost).toMatchObject({ available: true, currency: 'EUR', forecast: 412.35, last7Days: 96.1, budget: 500 });
    // Per hour times 730, most expensive first.
    expect(cost.breakdown).toEqual([
      { component: 'tokens', site: 'protected', monthly: 146 },
      { component: 'cpu', site: 'protected', monthly: 73 },
    ]);
    expect(cost.tokens).toEqual({
      forecast: 730000,
      budget: 1_000_000,
      byModel: [{ model: 'openai/gpt-oss-120b', input: 438000, output: 292000, monthlyCost: 146 }],
    });
    expect(new Set(urls)).toEqual(new Set(['http://prometheus-operated.demo.svc:9090']));
  });

  it('says why there is nothing to show', async () => {
    const noCatalog = new CostService({ getProject: async () => project({ currency: 'EUR' }), query });
    expect(await noCatalog.get('demo')).toMatchObject({ available: false, reason: expect.stringContaining('basis-prices') });

    const down = new CostService({
      getProject: async () => project({ costMetric: 'basis:cost_per_hour' }),
      query: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      prometheusUrl: 'http://localhost:9090/{project}',
    });
    expect(await down.get('demo')).toMatchObject({ available: false, reason: expect.stringContaining('ECONNREFUSED') });

    const fresh = new CostService({ getProject: async () => project({ costMetric: 'basis:cost_per_hour' }), query: async () => [] });
    expect(await fresh.get('demo')).toMatchObject({ available: false, reason: expect.stringContaining('No cost data yet') });
  });
});
