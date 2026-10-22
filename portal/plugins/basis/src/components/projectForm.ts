/**
 * Create-project form state and its mapping onto a Project spec. Like
 * form.ts: only what the form exposes is sent, the rest falls back to the
 * XRD defaults, and the API server has the final say.
 */

import type { Classification, Environment, Project } from '@internal/backstage-plugin-basis-common';
import { mergePatch, toMi } from './form';

export interface ProjectForm {
  name: string;
  owner: string;
  description: string;
  /** Where the databases run; fixed after creation. */
  protectedLocation: string;
  /** Where geo-replicated clusters keep a replica cluster; optional, can be added later, then fixed. */
  recoveryLocation: string;
  editGroup: string;
  viewGroup: string;
  quotaEnabled: boolean;
  quotaCpu: string;
  quotaMemory: string;
  quotaStorage: string;
  prometheusRetention: string;
  prometheusStorage: string;
  grafanaIngress: boolean;
  /** Governance and cost: what decides the allowed models and exposure, showback and expiry. */
  classification: Classification;
  environment: Environment;
  costCenter: string;
  /** Per month in the catalog's currency; empty for none. */
  budgetMonthly: string;
  /** Tokens per month through the project's gateways; empty for none. */
  budgetTokens: string;
  /** YYYY-MM-DD; empty for none. */
  expiresAt: string;
}

export const defaultProjectForm = (): ProjectForm => ({
  name: '',
  owner: '',
  description: '',
  protectedLocation: '',
  recoveryLocation: '',
  editGroup: '',
  viewGroup: '',
  quotaEnabled: false,
  quotaCpu: '8',
  quotaMemory: '32Gi',
  quotaStorage: '200Gi',
  prometheusRetention: '7d',
  prometheusStorage: '10Gi',
  grafanaIngress: true,
  classification: 'internal',
  environment: 'production',
  costCenter: '',
  budgetMonthly: '',
  budgetTokens: '',
  expiresAt: '',
});

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const RESERVED = [
  'default',
  'projects',
  'locations',
  'buckets',
  'volumes',
  'caches',
  'stacks',
  'gateways',
  'servers',
  'crossplane-system',
  'cnpg-system',
  'basis-locations',
  'cnpg-locations',
  'cert-manager',
];
const QUANTITY = /^[0-9]+(Mi|Gi|Ti)$/;

/** Field-level errors shown inline; mirrors the XRD's rules. */
export function validateProject(f: ProjectForm): Partial<Record<keyof ProjectForm, string>> {
  const e: Partial<Record<keyof ProjectForm, string>> = {};
  if (!NAME.test(f.name) || f.name.includes('--')) {
    e.name = 'Lowercase letters, digits and single "-", starting with a letter, max 40 characters.';
  } else if (f.name.startsWith('kube-') || RESERVED.includes(f.name)) {
    e.name = 'This name is reserved.';
  }
  if (f.owner && !/^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/.test(f.owner)) e.owner = 'A group name, e.g. team-payments.';
  if (f.description.length > 200) e.description = 'At most 200 characters.';
  if (!f.protectedLocation) e.protectedLocation = 'Pick the location the databases run in.';
  if (f.recoveryLocation && f.recoveryLocation === f.protectedLocation) {
    e.recoveryLocation = 'Pick another location than the protected one.';
  }
  if (f.quotaEnabled) {
    if (!/^[0-9]+(\.[0-9]+)?m?$/.test(f.quotaCpu)) e.quotaCpu = 'e.g. 8 or 500m';
    if (!QUANTITY.test(f.quotaMemory)) e.quotaMemory = 'e.g. 32Gi';
    if (!QUANTITY.test(f.quotaStorage)) e.quotaStorage = 'e.g. 200Gi';
  }
  if (!/^[0-9]+(h|d|w|y)$/.test(f.prometheusRetention)) e.prometheusRetention = 'e.g. 7d, 2w';
  if (f.costCenter && !/^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(f.costCenter)) {
    e.costCenter = 'Letters, digits, "-", "_" and ".", e.g. CC-4711.';
  }
  if (f.budgetMonthly && !(Number(f.budgetMonthly) >= 0)) e.budgetMonthly = 'A number, e.g. 2500.';
  if (f.budgetTokens && !/^[0-9]+$/.test(f.budgetTokens)) e.budgetTokens = 'A whole number, e.g. 50000000.';
  if (f.expiresAt && (!/^\d{4}-\d{2}-\d{2}$/.test(f.expiresAt) || Number.isNaN(Date.parse(f.expiresAt)))) {
    e.expiresAt = 'A date, YYYY-MM-DD.';
  }
  if (!QUANTITY.test(f.prometheusStorage)) e.prometheusStorage = 'e.g. 10Gi';
  return e;
}

/** The Project spec, without owner/description (sent as their own fields). */
export function toProjectSpec(f: ProjectForm): Record<string, unknown> {
  const access = [
    ...(f.editGroup.trim() ? [{ group: f.editGroup.trim(), role: 'edit' }] : []),
    ...(f.viewGroup.trim() ? [{ group: f.viewGroup.trim(), role: 'view' }] : []),
  ];
  return {
    locations: {
      protected: f.protectedLocation,
      ...(f.recoveryLocation ? { recovery: f.recoveryLocation } : {}),
    },
    ...(access.length ? { access } : {}),
    ...(f.quotaEnabled
      ? { quota: { cpu: f.quotaCpu, memory: f.quotaMemory, storage: f.quotaStorage } }
      : {}),
    observability: {
      prometheus: {
        retention: f.prometheusRetention,
        storage: { size: f.prometheusStorage },
      },
      grafana: { ingress: f.grafanaIngress },
    },
    classification: f.classification,
    environment: f.environment,
    ...(f.costCenter ? { costCenter: f.costCenter } : {}),
    ...(f.budgetMonthly || f.budgetTokens
      ? {
          budget: {
            ...(f.budgetMonthly ? { monthly: Number(f.budgetMonthly) } : {}),
            ...(f.budgetTokens ? { monthlyTokens: Number(f.budgetTokens) } : {}),
          },
        }
      : {}),
    ...(f.expiresAt ? { expiresAt: f.expiresAt } : {}),
  };
}

/** The manifest the form produces, for the preview pane. */
export function toProjectManifest(f: ProjectForm) {
  return {
    apiVersion: 'platform.cndev.nl/v1alpha1',
    kind: 'Project',
    metadata: { name: f.name || '<name>' },
    spec: {
      ...(f.owner ? { owner: f.owner } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...toProjectSpec(f),
    },
  };
}

/**
 * Whether the form's one edit group and one view group can show the
 * project's access list; otherwise the edit form leaves it alone.
 */
export function accessEditable(access: Project['spec']['access']): boolean {
  const roles = (access ?? []).map(a => a.role);
  return roles.every(r => r === 'edit' || r === 'view') && new Set(roles).size === roles.length;
}

/** The form for an existing project (its spec carries the XRD defaults). */
export function fromProject(project: Project): ProjectForm {
  const { spec, metadata } = project;
  const d = defaultProjectForm();
  const prom = spec.observability?.prometheus ?? {};
  const group = (role: string) => spec.access?.find(a => a.role === role)?.group ?? '';
  return {
    ...d,
    name: metadata.name,
    owner: spec.owner ?? '',
    description: spec.description ?? '',
    protectedLocation: spec.locations?.protected ?? '',
    recoveryLocation: spec.locations?.recovery ?? '',
    editGroup: group('edit'),
    viewGroup: group('view'),
    quotaEnabled: Boolean(spec.quota),
    quotaCpu: spec.quota?.cpu ?? d.quotaCpu,
    quotaMemory: spec.quota?.memory ?? d.quotaMemory,
    quotaStorage: spec.quota?.storage ?? d.quotaStorage,
    prometheusRetention: prom.retention ?? d.prometheusRetention,
    prometheusStorage: prom.storage?.size ?? d.prometheusStorage,
    grafanaIngress: spec.observability?.grafana?.ingress ?? d.grafanaIngress,
    classification: spec.classification ?? d.classification,
    environment: spec.environment ?? d.environment,
    costCenter: spec.costCenter ?? '',
    budgetMonthly: spec.budget?.monthly !== undefined ? String(spec.budget.monthly) : '',
    budgetTokens: spec.budget?.monthlyTokens !== undefined ? String(spec.budget.monthlyTokens) : '',
    expiresAt: spec.expiresAt ?? '',
  };
}

/**
 * The Prometheus volume can only grow, and the locations can't change once
 * set; a recovery location can be added (the XRD enforces the same).
 */
export function validateProjectEdit(
  original: ProjectForm,
  f: ProjectForm,
): Partial<Record<keyof ProjectForm, string>> {
  const e = validateProject(f);
  if (original.protectedLocation && f.protectedLocation !== original.protectedLocation) {
    e.protectedLocation = `Fixed: the project's databases run in ${original.protectedLocation}.`;
  }
  if (original.recoveryLocation && f.recoveryLocation !== original.recoveryLocation) {
    e.recoveryLocation = `Fixed: replica clusters run in ${original.recoveryLocation}.`;
  }
  if (!e.prometheusStorage && toMi(f.prometheusStorage) < toMi(original.prometheusStorage)) {
    e.prometheusStorage = `Can grow but not shrink (now ${original.prometheusStorage}).`;
  }
  return e;
}

/**
 * What an edit changes in the Project spec, as a merge patch. An emptied
 * owner or description becomes null (removed); with `keepAccess` the access
 * list isn't touched.
 */
export function toProjectEditPatch(
  original: ProjectForm,
  f: ProjectForm,
  { keepAccess = false } = {},
): Record<string, unknown> {
  const spec = (form: ProjectForm) => {
    const { access, ...rest } = toProjectSpec(form) as Record<string, unknown>;
    return {
      ...(form.owner ? { owner: form.owner } : {}),
      ...(form.description ? { description: form.description } : {}),
      ...(keepAccess ? {} : { access: access ?? [] }),
      ...rest,
    };
  };
  const patch = (mergePatch(spec(original), spec(f)) ?? {}) as Record<string, unknown>;
  // An empty list reads clearer in the object as "no access entries".
  if (Array.isArray(patch.access) && patch.access.length === 0) patch.access = null;
  return patch;
}
