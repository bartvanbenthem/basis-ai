/**
 * Create/edit-stack form state and its mapping onto a GenAIStack spec. Like
 * the other forms: the fields mirror the XRD, which (with the admission
 * policies) has the final say.
 */

import {
  type CacheMode,
  type GenAIStack,
  STACK_GROUP,
  STACK_KIND,
  STACK_VERSION,
} from '@internal/backstage-plugin-basis-common';
import { defaultExpose, type ExposeFields, fromExpose, toExpose, validateExpose } from './expose';
import { AUDIT_LOG, mergePatch, normalizeAuditLog } from './form';
import { emptyModel, fromModel, type ModelRow, providerKeys, toModels, validateModels } from './ModelFields';

export { emptyModel, type ModelRow };

export interface StackForm {
  name: string;
  namespace: string;
  owner: string;
  recovery: boolean;
  recoveryCacheMemory: string;
  recoveryGatewayReplicas: number;
  /** A size from the catalog; empty for the default resources. */
  size: string;
  instances: number;
  storageSize: string;
  backup: boolean;
  extensions: string[];
  /** retrieval.auditLog: pgaudit on the database, recording the classes in auditLog. */
  auditEnabled: boolean;
  auditLog: string;
  /** retrieval.expose: the database on a LoadBalancer (no hostname). */
  dbExpose: ExposeFields;
  cacheEnabled: boolean;
  cacheMode: CacheMode;
  cacheMemory: string;
  gatewayEnabled: boolean;
  /** A shared ModelGateway in the project; empty for the stack's own. */
  gatewayRef: string;
  /** The stack's client in the shared gateway; empty for the stack's name. */
  gatewayClient: string;
  gatewayReplicas: number;
  models: ModelRow[];
  /** gateway.expose: the stack's own gateway over HTTPS. */
  gatewayExpose: ExposeFields;
}

export const defaultStackForm = (): StackForm => ({
  name: '',
  namespace: '',
  owner: '',
  recovery: false,
  recoveryCacheMemory: '512Mi',
  recoveryGatewayReplicas: 1,
  size: '',
  instances: 3,
  storageSize: '20Gi',
  backup: false,
  extensions: ['vector'],
  auditEnabled: false,
  auditLog: 'ddl, role',
  dbExpose: defaultExpose(),
  cacheEnabled: true,
  cacheMode: 'semantic',
  cacheMemory: '1Gi',
  gatewayEnabled: true,
  gatewayRef: '',
  gatewayClient: '',
  gatewayReplicas: 2,
  models: [emptyModel()],
  gatewayExpose: defaultExpose(),
});

export function fromStack(stack: GenAIStack): StackForm {
  const { metadata, spec } = stack;
  const d = defaultStackForm();
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    owner: metadata.labels?.['backstage.io/owner'] ?? '',
    recovery: Boolean(spec.recovery?.enabled),
    recoveryCacheMemory: spec.recovery?.cacheMemory ?? d.recoveryCacheMemory,
    recoveryGatewayReplicas: spec.recovery?.gatewayReplicas ?? d.recoveryGatewayReplicas,
    size: spec.retrieval?.size ?? '',
    instances: spec.retrieval?.instances ?? d.instances,
    storageSize: spec.retrieval?.storageSize ?? d.storageSize,
    backup: Boolean(spec.retrieval?.backup),
    extensions: spec.retrieval?.extensions ?? d.extensions,
    auditEnabled: Boolean(spec.retrieval?.auditLog),
    auditLog: spec.retrieval?.auditLog || d.auditLog,
    dbExpose: fromExpose(spec.retrieval?.expose),
    cacheEnabled: spec.cache?.enabled ?? true,
    cacheMode: spec.cache?.mode ?? d.cacheMode,
    cacheMemory: spec.cache?.memory ?? d.cacheMemory,
    gatewayEnabled: spec.gateway?.enabled ?? true,
    gatewayRef: spec.gateway?.ref ?? '',
    gatewayClient: spec.gateway?.client ?? '',
    gatewayReplicas: spec.gateway?.replicas ?? d.gatewayReplicas,
    models: (spec.gateway?.models ?? []).map(m => fromModel(m, metadata.name)),
    gatewayExpose: fromExpose(spec.gateway?.expose),
  };
}

const NAME = /^[a-z]([-a-z0-9]{0,26}[a-z0-9])?$/;
const QUANTITY = /^[0-9]+(Mi|Gi)$/;
const CLIENT = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export type StackErrors = Partial<Record<Exclude<keyof StackForm, 'dbExpose' | 'gatewayExpose'>, string>> & {
  modelRows?: Record<number, string>;
  dbExposeSourceRanges?: string;
  gatewayExposeHostname?: string;
  gatewayExposeSourceRanges?: string;
};

/** Field-level errors shown inline; mirrors the XRD's rules. */
export function validateStack(f: StackForm): StackErrors {
  const e: StackErrors = {};
  if (!NAME.test(f.name)) e.name = 'Lowercase letters, digits and "-", starting with a letter, max 28 characters.';
  if (!f.namespace) e.namespace = 'Pick the project the stack belongs to.';
  if (f.owner && !/^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/.test(f.owner)) e.owner = 'A group name, e.g. team-payments.';
  if (!/^[0-9]+(Mi|Gi|Ti)$/.test(f.storageSize)) e.storageSize = 'e.g. 20Gi';
  if (f.auditEnabled && !AUDIT_LOG.test(f.auditLog)) {
    e.auditLog = 'Classes separated by commas, e.g. ddl, role; prefix "-" to leave one out.';
  }
  if (f.cacheEnabled && !QUANTITY.test(f.cacheMemory)) e.cacheMemory = 'e.g. 1Gi';
  if (f.recovery && f.cacheEnabled && !QUANTITY.test(f.recoveryCacheMemory)) e.recoveryCacheMemory = 'e.g. 512Mi';
  if (f.gatewayEnabled && f.gatewayRef) {
    if (f.gatewayClient && !CLIENT.test(f.gatewayClient)) e.gatewayClient = 'Lowercase letters, digits and "-".';
  } else if (f.gatewayEnabled) {
    const rows = validateModels(f.models);
    if (Object.keys(rows).length) e.modelRows = rows;
    const gw = validateExpose(f.gatewayExpose);
    if (gw.hostname) e.gatewayExposeHostname = gw.hostname;
    if (gw.sourceRanges) e.gatewayExposeSourceRanges = gw.sourceRanges;
  }
  const db = validateExpose(f.dbExpose, { hostname: false });
  if (db.sourceRanges) e.dbExposeSourceRanges = db.sourceRanges;
  return e;
}

export const hasErrors = (e: StackErrors) => Object.keys(e).length > 0;

export function toStackSpec(f: StackForm): Record<string, unknown> {
  return {
    recovery: {
      enabled: f.recovery,
      cacheMemory: f.recoveryCacheMemory,
      gatewayReplicas: f.recoveryGatewayReplicas,
    },
    retrieval: {
      ...(f.size ? { size: f.size } : {}),
      instances: f.instances,
      storageSize: f.storageSize,
      backup: f.backup,
      extensions: f.extensions,
      ...(f.auditEnabled ? { auditLog: normalizeAuditLog(f.auditLog) } : {}),
      ...(f.dbExpose.enabled ? { expose: toExpose(f.dbExpose, { hostname: false }) } : {}),
    },
    cache: { enabled: f.cacheEnabled, mode: f.cacheMode, memory: f.cacheMemory },
    gateway: f.gatewayRef
      ? {
          enabled: f.gatewayEnabled,
          ref: f.gatewayRef,
          ...(f.gatewayClient ? { client: f.gatewayClient } : {}),
          models: [],
        }
      : {
          enabled: f.gatewayEnabled,
          replicas: f.gatewayReplicas,
          models: toModels(f.models, f.name),
          ...(f.gatewayExpose.enabled ? { expose: toExpose(f.gatewayExpose) } : {}),
        },
  };
}

export function toStackManifest(f: StackForm) {
  return {
    apiVersion: `${STACK_GROUP}/${STACK_VERSION}`,
    kind: STACK_KIND,
    metadata: {
      name: f.name || '<name>',
      namespace: f.namespace || '<project>',
      ...(f.owner ? { labels: { 'backstage.io/owner': f.owner } } : {}),
    },
    spec: toStackSpec(f),
  };
}

/** What an edit changes: a merge patch. The models list is replaced as a whole. */
export function toStackEditPatch(original: StackForm, f: StackForm): Record<string, unknown> {
  return (mergePatch(toStackSpec(original), toStackSpec(f)) ?? {}) as Record<string, unknown>;
}

/** The provider keys entered for the stack's own gateway, by model name (never in the spec). */
export const stackProviderKeys = (f: StackForm) => (f.gatewayEnabled && !f.gatewayRef ? providerKeys(f.models) : undefined);
