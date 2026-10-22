import { coreServices, createServiceFactory, createServiceRef } from '@backstage/backend-plugin-api';
import type { Project, ProjectCost } from '@internal/backstage-plugin-basis-common';
import { basisKubernetesServiceRef } from './BasisKubernetesService';

/** Prices are per month; the rules record per hour (365 * 24 / 12). */
const HOURS_PER_MONTH = 730;
const QUERY_TIMEOUT_MS = 10_000;

/** A Prometheus instant query's result: label sets and their values. */
export type Sample = { metric: Record<string, string>; value: number };
export type Query = (prometheusUrl: string, promql: string) => Promise<Sample[]>;

/** An instant query against Prometheus' HTTP API. */
export const prometheusQuery: Query = async (url, promql) => {
  const res = await fetch(`${url.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(promql)}`, {
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Prometheus answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: { result?: Array<{ metric: Record<string, string>; value: [number, string] }> } };
  return (body.data?.result ?? []).map(r => ({ metric: r.metric, value: Number(r.value[1]) }));
};

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * A project's cost and token use, from the recording rules the Project
 * composition puts in its control-plane Prometheus (basis:cost_per_hour,
 * basis:tokens_per_hour and their monthly forecasts; function/project/governance.go).
 */
export class CostService {
  readonly #getProject: (name: string) => Promise<Project>;
  readonly #query: Query;
  readonly #urlTemplate?: string;

  constructor(options: { getProject: (name: string) => Promise<Project>; query?: Query; prometheusUrl?: string }) {
    this.#getProject = options.getProject;
    this.#query = options.query ?? prometheusQuery;
    this.#urlTemplate = options.prometheusUrl;
  }

  async get(project: string): Promise<ProjectCost> {
    const resource = await this.#getProject(project);
    const governance = resource.status?.governance;
    const currency = governance?.currency ?? 'EUR';
    const budget = resource.spec.budget?.monthly;
    const tokenBudget = resource.spec.budget?.monthlyTokens;
    const empty = (reason: string): ProjectCost => ({
      available: false, reason, currency, budget, breakdown: [], tokens: { budget: tokenBudget, byModel: [] },
    });
    if (!governance?.costMetric) {
      return empty('No cost rules: the platform has no price catalog (EnvironmentConfig basis-prices).');
    }
    // In the cluster, the project's Prometheus by its Service; elsewhere (development) as configured.
    const url = this.#urlTemplate?.replace('{project}', project) ?? resource.status?.prometheus?.url;
    if (!url) return empty("The project's Prometheus is off.");

    const ns = `namespace="${project}"`;
    const q = (promql: string) => this.#query(url, promql);
    let results: Sample[][];
    try {
      results = await Promise.all([
        q(`basis:cost_monthly_forecast{${ns}}`),
        q(`sum_over_time(sum(basis:cost_per_hour{${ns}})[7d:1h])`),
        q(`sum by (component, site) (basis:cost_per_hour{${ns}})`),
        q(`basis:tokens_monthly_forecast{${ns}}`),
        q(`sum by (gen_ai_request_model, gen_ai_token_type) (basis:tokens_per_hour{${ns}})`),
        q(`sum by (gen_ai_request_model) (basis:cost_per_hour{${ns},component="tokens"})`),
      ]);
    } catch (e) {
      return empty(`The project's Prometheus can't be read: ${(e as Error).message}`);
    }
    const [forecast, week, byComponent, tokenForecast, tokens, tokenCost] = results;
    if (!byComponent.length) {
      return empty('No cost data yet: the rules record every minute once the locations send their metrics.');
    }

    const models = new Map<string, { model: string; input: number; output: number; monthlyCost: number }>();
    const model = (name: string) => {
      if (!models.has(name)) models.set(name, { model: name, input: 0, output: 0, monthlyCost: 0 });
      return models.get(name)!;
    };
    for (const s of tokens) {
      const m = model(s.metric.gen_ai_request_model ?? '');
      if (s.metric.gen_ai_token_type === 'input') m.input += s.value * HOURS_PER_MONTH;
      if (s.metric.gen_ai_token_type === 'output') m.output += s.value * HOURS_PER_MONTH;
    }
    for (const s of tokenCost) model(s.metric.gen_ai_request_model ?? '').monthlyCost += s.value * HOURS_PER_MONTH;

    return {
      available: true,
      currency,
      budget,
      forecast: forecast[0] ? round(forecast[0].value) : undefined,
      last7Days: week[0] ? round(week[0].value) : undefined,
      breakdown: byComponent
        .map(s => ({ component: s.metric.component ?? '', site: s.metric.site ?? '', monthly: round(s.value * HOURS_PER_MONTH) }))
        .sort((a, b) => b.monthly - a.monthly),
      tokens: {
        forecast: tokenForecast[0] ? Math.round(tokenForecast[0].value) : undefined,
        budget: tokenBudget,
        byModel: [...models.values()]
          .map(m => ({ ...m, input: Math.round(m.input), output: Math.round(m.output), monthlyCost: round(m.monthlyCost) }))
          .sort((a, b) => b.monthlyCost - a.monthlyCost),
      },
    };
  }
}

export const costServiceRef = createServiceRef<CostService>({
  id: 'basis.cost',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { k8s: basisKubernetesServiceRef, config: coreServices.rootConfig },
      factory: ({ k8s, config }) =>
        new CostService({
          getProject: name => k8s.getProject(name),
          prometheusUrl: config.getOptionalString('basis.cost.prometheusUrl'),
        }),
    }),
});
