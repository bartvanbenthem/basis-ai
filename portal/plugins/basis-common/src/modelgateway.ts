/**
 * Shapes of the ai.cndev.nl/v1alpha1 ModelGateway API served by api/
 * (apis/modelgateway). The XRD is the source of truth; these types only cover
 * what the portal reads or sends.
 */

import type { Condition, Project, Site } from './types';

export const GATEWAY_GROUP = 'ai.cndev.nl';
export const GATEWAY_VERSION = 'v1alpha1';
export const GATEWAY_PLURAL = 'modelgateways';
export const GATEWAY_KIND = 'ModelGateway';

/** Annotation on catalog Resource entities: "<namespace>/<name>" of their ModelGateway. */
export const GATEWAY_ANNOTATION = 'ai.cndev.nl/modelgateway';

/** The label a GenAIStack puts on what it composes: its database, caches and gateway. */
export const STACK_OWNER_LABEL = 'ai.cndev.nl/genaistack';

/** The model APIs a gateway speaks to (OpenAI covers every OpenAI-compatible server). */
export const MODEL_SCHEMAS = ['OpenAI', 'Anthropic'] as const;
export type ModelSchema = (typeof MODEL_SCHEMAS)[number];

export interface GatewayModel {
  /** What clients send as "model". */
  name: string;
  /** Base URL of the provider's API, its path the API prefix; a hosted model's. */
  endpoint?: string;
  /** A ModelServer in the project instead of an endpoint: a self-hosted model. */
  server?: string;
  schema?: ModelSchema;
  upstreamModel?: string;
  apiKeySecretRef?: { name: string; key?: string };
  /** Other models of the gateway to try, in order, when this one fails. */
  fallbacks?: string[];
}

/** spec.retry: attempts per model, then its fallbacks. */
export interface GatewayRetry {
  attempts?: number;
  retryOn?: number[];
  perTryTimeout?: string;
}

/** Per-minute caps, for the gateway (spec.rateLimit) or a client. */
export interface GatewayPerMinute {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

/** spec.expose: HTTPS at hostname on a LoadBalancer of its own, for clients outside the location. */
export interface GatewayExpose {
  enabled?: boolean;
  hostname?: string;
  /** cert-manager ClusterIssuer in each location; basis by default. */
  issuer?: string;
  annotations?: Record<string, string>;
  loadBalancerSourceRanges?: string[];
}

export interface ModelGatewaySpec {
  replicas?: number;
  recovery?: { enabled?: boolean; replicas?: number };
  activeSite?: Site;
  /** Each client gets an API key of its own in Secret <name>-keys. */
  clients?: GatewayClient[];
  models?: GatewayModel[];
  expose?: GatewayExpose;
  /** Tokens all clients together may use per month (per site); 429 past it. */
  monthlyTokens?: number;
  retry?: GatewayRetry;
  rateLimit?: GatewayPerMinute;
  alerts?: { latencySeconds?: number; timeToFirstTokenSeconds?: number; errorRatePercent?: number; disabled?: boolean };
}

export interface GatewayClient extends GatewayPerMinute {
  name: string;
  /** Who to ask about the key. */
  owner?: string;
  /** Tokens this client may use per month (per site); 429 past it. */
  monthlyTokens?: number;
  /** The key's last day (YYYY-MM-DD); after it the key is revoked. */
  expiresAt?: string;
}

export interface GatewaySiteStatus {
  site: Site;
  location: string;
  active: boolean;
  replicas?: number;
  /** The site's external LoadBalancer address (spec.expose), once it has one. */
  address?: string;
}

export interface ModelGateway {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec: ModelGatewaySpec;
  status?: {
    ready?: boolean;
    message?: string;
    activeSite?: Site;
    models?: number;
    clients?: number;
    endpoint?: string;
    externalEndpoint?: string;
    keysSecret?: string;
    sites?: GatewaySiteStatus[];
    /** Clients past their expiresAt: their keys are revoked. */
    expiredClients?: string[];
    /** The gateway's dashboard in the project's Grafana: <grafana>/d/<uid>. */
    dashboardUid?: string;
    conditions?: Condition[];
  };
}

/** One row in the portal's gateway list. */
export interface ModelGatewaySummary {
  name: string;
  namespace: string;
  recovery: boolean;
  activeSite: Site;
  models: string[];
  clients: string[];
  /** OPENAI_BASE_URL for clients in each site's location. */
  endpoint: string;
  /** https://<hostname>/v1 for clients outside the location, when exposed. */
  externalEndpoint?: string;
  keysSecret: string;
  ready: boolean;
  synced: boolean;
  deleting: boolean;
  message?: string;
  owner?: string;
  /** The GenAIStack that composes this gateway, if any: it's changed through the stack. */
  stack?: string;
  sites: GatewaySiteStatus[];
  createdAt?: string;
  project?: string;
}

/** A client's API key; only with basis.gateway.credentials.read. */
export interface GatewayKey {
  client: string;
  key: string;
}

export const gatewayEndpoint = (name: string, namespace: string) => `http://${name}.${namespace}.svc/v1`;

export function summarizeGateway(gw: ModelGateway, project?: Project): ModelGatewaySummary {
  const { metadata, spec, status } = gw;
  const condition = (type: string) => status?.conditions?.find(c => c.type === type)?.status === 'True';
  const recovery = Boolean(spec.recovery?.enabled);
  const sites: GatewaySiteStatus[] =
    status?.sites ??
    (['protected', ...(recovery ? ['recovery'] : [])] as Site[]).map(site => ({
      site,
      location: project?.spec.locations?.[site] ?? '',
      active: site === (spec.activeSite ?? 'protected'),
    }));
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    recovery,
    activeSite: status?.activeSite ?? spec.activeSite ?? 'protected',
    models: (spec.models ?? []).map(m => m.name),
    clients: (spec.clients ?? [{ name: 'apps' }]).map(c => c.name),
    endpoint: status?.endpoint ?? gatewayEndpoint(metadata.name, metadata.namespace),
    externalEndpoint:
      status?.externalEndpoint ?? (spec.expose?.enabled && spec.expose.hostname ? `https://${spec.expose.hostname}/v1` : undefined),
    keysSecret: status?.keysSecret ?? `${metadata.name}-keys`,
    ready: condition('Ready'),
    synced: condition('Synced'),
    deleting: Boolean(metadata.deletionTimestamp),
    message: status?.message,
    owner: metadata.labels?.['backstage.io/owner'],
    stack: metadata.labels?.[STACK_OWNER_LABEL] || undefined,
    sites,
    createdAt: metadata.creationTimestamp,
  };
}

/**
 * The Secret the portal writes a provider API key into, when it's entered in
 * a form: in the project namespace, named after the stack or gateway and the
 * model, the key under "apiKey". Deterministic, so the form can show the
 * reference it sends before the Secret exists.
 */
export function providerKeySecretName(owner: string, model: string): string {
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  // FNV-1a: tells models apart whose names slug the same (Gpt.4 / gpt-4).
  let h = 0x811c9dc5;
  for (const c of model) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${owner}-key-${slug ? `${slug}-` : ''}${h.toString(16).padStart(8, '0')}`;
}

/** The key in a provider key Secret the portal writes. */
export const PROVIDER_KEY_FIELD = 'apiKey';
