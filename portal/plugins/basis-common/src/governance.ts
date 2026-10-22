/**
 * Governance and cost of a Project (the API's spec.classification,
 * .environment, .costCenter, .budget, .expiresAt; apis/project/governance.yaml
 * and the cost rules of function/project/governance.go).
 */

export const CLASSIFICATIONS = ['public', 'internal', 'confidential'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const ENVIRONMENTS = ['production', 'staging', 'development', 'sandbox'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** What a classification means for the models and the exposure (the defaults of the basis-models catalog). */
export const CLASSIFICATION_HINTS: Record<Classification, string> = {
  public: 'Any model in the catalog.',
  internal: 'Any model in the catalog.',
  confidential: 'Self-hosted and EU models only; nothing opens to 0.0.0.0/0.',
};

export interface ProjectGovernanceStatus {
  classification?: Classification;
  environment?: Environment;
  costCenter?: string;
  expiresAt?: string;
  expired?: boolean;
  currency?: string;
  costMetric?: string;
  budget?: { monthly?: number; monthlyTokens?: number };
}

/** A project's cost, as the portal's backend reads it from the project's Prometheus. */
export interface ProjectCost {
  /** False without the basis-prices catalog (no cost rules) or without data yet. */
  available: boolean;
  /** Why not, when not available. */
  reason?: string;
  currency: string;
  /** The month at the last day's run rate. */
  forecast?: number;
  /** Spent in the last 7 days (as far as the Prometheus retains). */
  last7Days?: number;
  budget?: number;
  /** Per component (cpu, memory, storage, loadbalancer, tokens) and site, per month at the current rate. */
  breakdown: Array<{ component: string; site: string; monthly: number }>;
  tokens: {
    /** All models, the month at the last day's rate. */
    forecast?: number;
    budget?: number;
    /** Per model, per month at the current rate. */
    byModel: Array<{ model: string; input: number; output: number; monthlyCost: number }>;
  };
}
