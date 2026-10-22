/**
 * Create/edit-gateway form state and its mapping onto a ModelGateway spec.
 * Like the other forms: the fields mirror the XRD, which (with the admission
 * policies) has the final say.
 */

import {
  GATEWAY_GROUP,
  GATEWAY_KIND,
  GATEWAY_VERSION,
  type ModelGateway,
} from '@internal/backstage-plugin-basis-common';
import { defaultExpose, type ExposeFields, fromExpose, toExpose, validateExpose } from './expose';
import { mergePatch } from './form';
import { emptyModel, fromModel, type ModelRow, providerKeys, toModels, validateModels } from './ModelFields';

export interface GatewayForm {
  name: string;
  namespace: string;
  owner: string;
  replicas: number;
  recovery: boolean;
  recoveryReplicas: number;
  /** Who may call the gateway; each gets an API key of its own. */
  clients: string[];
  /** Per client name: its owner, monthly token cap and key expiry (empty for none). */
  clientSettings: Record<string, ClientSettings>;
  /** Tokens all clients together may use per month; empty for no cap. */
  monthlyTokens: string;
  /** spec.retry.attempts: per model, then each fallback. */
  retryAttempts: number;
  /** spec.rateLimit, per minute for all clients; empty for no cap. */
  requestsPerMinute: string;
  tokensPerMinute: string;
  models: ModelRow[];
  /** spec.expose: HTTPS at a hostname for clients outside the location. */
  expose: ExposeFields;
}

export interface ClientSettings {
  owner: string;
  monthlyTokens: string;
  expiresAt: string;
  requestsPerMinute?: string;
  tokensPerMinute?: string;
}

export const emptyClientSettings = (): ClientSettings => ({
  owner: '',
  monthlyTokens: '',
  expiresAt: '',
  requestsPerMinute: '',
  tokensPerMinute: '',
});

const num = (v?: number) => (v ? String(v) : '');

export const defaultGatewayForm = (): GatewayForm => ({
  name: '',
  namespace: '',
  owner: '',
  replicas: 2,
  recovery: false,
  recoveryReplicas: 1,
  clients: ['apps'],
  clientSettings: {},
  monthlyTokens: '',
  retryAttempts: 2,
  requestsPerMinute: '',
  tokensPerMinute: '',
  models: [emptyModel()],
  expose: defaultExpose(),
});

export function fromGateway(gw: ModelGateway): GatewayForm {
  const { metadata, spec } = gw;
  const d = defaultGatewayForm();
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    owner: metadata.labels?.['backstage.io/owner'] ?? '',
    replicas: spec.replicas ?? d.replicas,
    recovery: Boolean(spec.recovery?.enabled),
    recoveryReplicas: spec.recovery?.replicas ?? d.recoveryReplicas,
    clients: (spec.clients ?? [{ name: 'apps' }]).map(c => c.name),
    clientSettings: Object.fromEntries(
      (spec.clients ?? []).map(c => [
        c.name,
        {
          owner: c.owner ?? '',
          monthlyTokens: num(c.monthlyTokens),
          expiresAt: c.expiresAt ?? '',
          requestsPerMinute: num(c.requestsPerMinute),
          tokensPerMinute: num(c.tokensPerMinute),
        },
      ]),
    ),
    monthlyTokens: spec.monthlyTokens ? String(spec.monthlyTokens) : '',
    retryAttempts: spec.retry?.attempts ?? d.retryAttempts,
    requestsPerMinute: num(spec.rateLimit?.requestsPerMinute),
    tokensPerMinute: num(spec.rateLimit?.tokensPerMinute),
    models: (spec.models ?? []).map(m => fromModel(m, metadata.name)),
    expose: fromExpose(spec.expose),
  };
}

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const CLIENT = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const TOKENS = /^[1-9][0-9]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type GatewayErrors = Partial<Record<Exclude<keyof GatewayForm, 'expose'>, string>> & {
  modelRows?: Record<number, string>;
  exposeHostname?: string;
  exposeSourceRanges?: string;
};

/** Field-level errors shown inline; mirrors the XRD's rules. */
export function validateGateway(f: GatewayForm): GatewayErrors {
  const e: GatewayErrors = {};
  if (!NAME.test(f.name)) e.name = 'Lowercase letters, digits and "-", starting with a letter, max 40 characters.';
  if (!f.namespace) e.namespace = 'Pick the project the gateway belongs to.';
  if (f.owner && !/^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/.test(f.owner)) e.owner = 'A group name, e.g. team-payments.';
  const clients = f.clients.map(c => c.trim()).filter(Boolean);
  const bad = clients.find(c => !CLIENT.test(c));
  if (bad) e.clients = `Client ${bad}: lowercase letters, digits and "-".`;
  else if (new Set(clients).size !== clients.length) e.clients = 'A client is listed twice.';
  for (const c of clients) {
    const s = f.clientSettings[c];
    if (s?.monthlyTokens && !TOKENS.test(s.monthlyTokens)) e.clientSettings = `Client ${c}: tokens per month, a whole number.`;
    else if (s?.requestsPerMinute && !TOKENS.test(s.requestsPerMinute)) e.clientSettings = `Client ${c}: requests per minute, a whole number.`;
    else if (s?.tokensPerMinute && !TOKENS.test(s.tokensPerMinute)) e.clientSettings = `Client ${c}: tokens per minute, a whole number.`;
    else if (s?.expiresAt && !DATE.test(s.expiresAt)) e.clientSettings = `Client ${c}: expires as YYYY-MM-DD.`;
  }
  if (f.monthlyTokens && !TOKENS.test(f.monthlyTokens)) e.monthlyTokens = 'A whole number, e.g. 10000000.';
  if (f.requestsPerMinute && !TOKENS.test(f.requestsPerMinute)) e.requestsPerMinute = 'A whole number, e.g. 600.';
  if (f.tokensPerMinute && !TOKENS.test(f.tokensPerMinute)) e.tokensPerMinute = 'A whole number, e.g. 200000.';
  const rows = validateModels(f.models);
  if (Object.keys(rows).length) e.modelRows = rows;
  const expose = validateExpose(f.expose);
  if (expose.hostname) e.exposeHostname = expose.hostname;
  if (expose.sourceRanges) e.exposeSourceRanges = expose.sourceRanges;
  return e;
}

export const hasErrors = (e: GatewayErrors) => Object.keys(e).length > 0;

export function toGatewaySpec(f: GatewayForm): Record<string, unknown> {
  return {
    replicas: f.replicas,
    recovery: { enabled: f.recovery, replicas: f.recoveryReplicas },
    clients: f.clients
      .map(c => c.trim())
      .filter(Boolean)
      .map(name => {
        const s = f.clientSettings[name] ?? emptyClientSettings();
        return {
          name,
          ...(s.owner.trim() ? { owner: s.owner.trim() } : {}),
          ...(s.monthlyTokens ? { monthlyTokens: Number(s.monthlyTokens) } : {}),
          ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
          ...(s.requestsPerMinute ? { requestsPerMinute: Number(s.requestsPerMinute) } : {}),
          ...(s.tokensPerMinute ? { tokensPerMinute: Number(s.tokensPerMinute) } : {}),
        };
      }),
    models: toModels(f.models, f.name),
    ...(f.expose.enabled ? { expose: toExpose(f.expose) } : {}),
    ...(f.monthlyTokens ? { monthlyTokens: Number(f.monthlyTokens) } : {}),
    retry: { attempts: f.retryAttempts },
    ...(f.requestsPerMinute || f.tokensPerMinute
      ? {
          rateLimit: {
            ...(f.requestsPerMinute ? { requestsPerMinute: Number(f.requestsPerMinute) } : {}),
            ...(f.tokensPerMinute ? { tokensPerMinute: Number(f.tokensPerMinute) } : {}),
          },
        }
      : {}),
  };
}

export function toGatewayManifest(f: GatewayForm) {
  return {
    apiVersion: `${GATEWAY_GROUP}/${GATEWAY_VERSION}`,
    kind: GATEWAY_KIND,
    metadata: {
      name: f.name || '<name>',
      namespace: f.namespace || '<project>',
      ...(f.owner ? { labels: { 'backstage.io/owner': f.owner } } : {}),
    },
    spec: toGatewaySpec(f),
  };
}

/** What an edit changes: a merge patch. The clients and models lists are replaced as a whole. */
export function toGatewayEditPatch(original: GatewayForm, f: GatewayForm): Record<string, unknown> {
  return (mergePatch(toGatewaySpec(original), toGatewaySpec(f)) ?? {}) as Record<string, unknown>;
}

/** The provider keys entered in the form, by model name (never in the spec). */
export const gatewayProviderKeys = (f: GatewayForm) => providerKeys(f.models);
