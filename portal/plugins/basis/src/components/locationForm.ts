import type {
  LocationEnvironment,
  LocationProvider,
  LocationSpec,
  LocationSummary,
} from '@internal/backstage-plugin-cnpg-common';
import { parse } from 'yaml';

export const ENVIRONMENT_LABELS: Record<LocationEnvironment, string> = {
  production: 'Production',
  acceptance: 'Acceptance',
  test: 'Test',
  development: 'Development',
};

export const PROVIDER_LABELS: Record<LocationProvider, string> = {
  'on-premises': 'On-premises',
  aks: 'Azure AKS',
  eks: 'Amazon EKS',
  gke: 'Google GKE',
  ske: 'STACKIT SKE',
  openshift: 'OpenShift',
  kind: 'kind (local)',
  other: 'Other',
};

/** Select value for "not set" (an empty key isn't a valid option id). */
export const NONE = 'none';

export interface LocationForm {
  name: string;
  displayName: string;
  description: string;
  owner: string;
  environment: LocationEnvironment | typeof NONE;
  provider: LocationProvider | typeof NONE;
  region: string;
  storageClass: string;
  schedulable: boolean;
  /** kubeconfig text, uploaded or pasted; empty on edit keeps the stored one. */
  kubeconfig: string;
  /** Name of the uploaded file, for display. */
  fileName?: string;
  /** Context to keep; empty means the kubeconfig's current-context. */
  context: string;
}

export const defaultLocationForm = (): LocationForm => ({
  name: '',
  displayName: '',
  description: '',
  owner: '',
  environment: NONE,
  provider: NONE,
  region: '',
  storageClass: '',
  schedulable: true,
  kubeconfig: '',
  context: '',
});

/** The edit form for a stored location; its kubeconfig never comes back from the backend. */
export function fromLocation(l: LocationSummary): LocationForm {
  return {
    ...defaultLocationForm(),
    name: l.name,
    displayName: l.spec.displayName ?? '',
    description: l.spec.description ?? '',
    owner: l.spec.owner ?? '',
    environment: l.spec.environment ?? NONE,
    provider: l.spec.provider ?? NONE,
    region: l.spec.region ?? '',
    storageClass: l.spec.storageClass ?? '',
    schedulable: l.spec.schedulable ?? true,
  };
}

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** The contexts in a kubeconfig, for the context picker. The backend does the real validation. */
export function kubeconfigContexts(
  text: string,
): { contexts: string[]; current?: string; error?: string } {
  if (!text.trim()) return { contexts: [] };
  try {
    const raw = parse(text);
    const contexts = Array.isArray(raw?.contexts)
      ? (raw.contexts.map((c: any) => c?.name).filter(Boolean) as string[])
      : [];
    if (!contexts.length) return { contexts, error: 'No contexts found in this kubeconfig.' };
    return { contexts, current: raw['current-context'] };
  } catch {
    return { contexts: [], error: 'Not valid YAML.' };
  }
}

/** The context the form shows as selected: the chosen one, else current-context, else the first. */
export function chosenContext(f: LocationForm): string | undefined {
  if (f.context) return f.context;
  const { contexts, current } = kubeconfigContexts(f.kubeconfig);
  return current ?? contexts[0];
}

/** Field-level errors shown inline; mirrors the backend's schema. */
export function validateLocation(
  f: LocationForm,
  options: { editing?: boolean } = {},
): Partial<Record<keyof LocationForm, string>> {
  const e: Partial<Record<keyof LocationForm, string>> = {};
  if (!NAME.test(f.name)) {
    e.name = 'Lowercase letters, digits and "-", starting with a letter, max 40 characters.';
  }
  if (f.displayName.length > 80) e.displayName = 'At most 80 characters.';
  if (f.description.length > 300) e.description = 'At most 300 characters.';
  if (f.region.length > 63) e.region = 'At most 63 characters.';
  if (f.owner && !LABEL_VALUE.test(f.owner)) e.owner = 'A group name, e.g. team-platform.';
  if (f.storageClass && !DNS_SUBDOMAIN.test(f.storageClass)) {
    e.storageClass = 'A StorageClass name, e.g. managed-csi.';
  }
  if (!f.kubeconfig.trim()) {
    if (!options.editing) e.kubeconfig = 'Upload or paste the kubeconfig of the cluster.';
  } else {
    const { contexts, error } = kubeconfigContexts(f.kubeconfig);
    if (error) e.kubeconfig = error;
    else if (f.context && !contexts.includes(f.context)) e.context = 'Not in this kubeconfig.';
  }
  return e;
}

export function toLocationSpec(f: LocationForm): LocationSpec {
  const text = (v: string) => v.trim() || undefined;
  return {
    displayName: text(f.displayName),
    description: text(f.description),
    owner: text(f.owner),
    environment: f.environment === NONE ? undefined : f.environment,
    provider: f.provider === NONE ? undefined : f.provider,
    region: text(f.region),
    storageClass: text(f.storageClass),
    schedulable: f.schedulable,
  };
}
