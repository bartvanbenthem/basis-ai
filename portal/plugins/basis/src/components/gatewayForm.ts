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
  models: ModelRow[];
  /** spec.expose: HTTPS at a hostname for clients outside the location. */
  expose: ExposeFields;
}

export const defaultGatewayForm = (): GatewayForm => ({
  name: '',
  namespace: '',
  owner: '',
  replicas: 2,
  recovery: false,
  recoveryReplicas: 1,
  clients: ['apps'],
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
    models: (spec.models ?? []).map(m => fromModel(m, metadata.name)),
    expose: fromExpose(spec.expose),
  };
}

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const CLIENT = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

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
      .map(name => ({ name })),
    models: toModels(f.models, f.name),
    ...(f.expose.enabled ? { expose: toExpose(f.expose) } : {}),
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
