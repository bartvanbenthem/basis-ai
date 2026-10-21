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
  /** Base URL of the provider's API, its path the API prefix. */
  endpoint: string;
  schema?: ModelSchema;
  upstreamModel?: string;
  apiKeySecretRef?: { name: string; key?: string };
}

export interface ModelGatewaySpec {
  replicas?: number;
  recovery?: { enabled?: boolean; replicas?: number };
  activeSite?: Site;
  /** Each client gets an API key of its own in Secret <name>-keys. */
  clients?: Array<{ name: string }>;
  models?: GatewayModel[];
}

export interface GatewaySiteStatus {
  site: Site;
  location: string;
  active: boolean;
  replicas?: number;
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
    keysSecret?: string;
    sites?: GatewaySiteStatus[];
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
