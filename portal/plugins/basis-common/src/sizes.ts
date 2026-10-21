/**
 * Sizes (SKUs) a PostgresCluster picks with spec.size: the EnvironmentConfig
 * postgres-sizes on the control plane
 * (api/apis/postgrescluster/sizes.yaml). The composition gives the instances the
 * size's resources and PostgreSQL settings; the portal also suggests its
 * volume sizes for a new cluster.
 */

export const SIZES_GROUP = 'apiextensions.crossplane.io';
export const SIZES_VERSION = 'v1beta1';
export const SIZES_PLURAL = 'environmentconfigs';
export const SIZES_NAME = 'postgres-sizes';

export interface ClusterResources {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

export interface ClusterSize {
  /** What spec.size says. */
  name: string;
  displayName: string;
  description?: string;
  resources: ClusterResources;
  /** postgresql.conf settings tuned to the size; spec.postgresql.parameters win. */
  parameters: Record<string, string>;
  /** Suggested volumes for a new cluster; the API leaves them to spec.storage/walStorage. */
  storage?: { size?: string; walSize?: string };
}

const NAME = /^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/;
const QUANTITY = /^[0-9]+(Mi|Gi|Ti)$/;

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);

function resources(v: any): ClusterResources {
  const part = (p: any) => {
    const cpu = str(p?.cpu);
    const memory = str(p?.memory);
    return cpu || memory ? { ...(cpu ? { cpu } : {}), ...(memory ? { memory } : {}) } : undefined;
  };
  const requests = part(v?.requests);
  const limits = part(v?.limits);
  return { ...(requests ? { requests } : {}), ...(limits ? { limits } : {}) };
}

/**
 * The sizes in an EnvironmentConfig's data, in catalog order. Entries
 * without a valid name are skipped, as the admission policy and the
 * composition can't use them either.
 */
export function parseSizes(data: unknown): ClusterSize[] {
  const list = (data as any)?.sizes;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const sizes: ClusterSize[] = [];
  for (const s of list) {
    const name = str(s?.name);
    if (!name || !NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const parameters = Object.fromEntries(
      Object.entries(s.parameters && typeof s.parameters === 'object' ? s.parameters : {})
        .map(([k, v]) => [k, str(v)])
        .filter((e): e is [string, string] => e[1] !== undefined),
    );
    const size = str(s.storage?.size);
    const walSize = str(s.storage?.walSize);
    sizes.push({
      name,
      displayName: str(s.displayName) || name.toUpperCase(),
      ...(str(s.description) ? { description: str(s.description) } : {}),
      resources: resources(s.resources),
      parameters,
      ...(size && QUANTITY.test(size)
        ? { storage: { size, ...(walSize && QUANTITY.test(walSize) ? { walSize } : {}) } }
        : {}),
    });
  }
  return sizes;
}

/** "2 vCPU", "500m CPU". */
export function cpuLabel(cpu?: string): string | undefined {
  if (!cpu) return undefined;
  return /^[0-9.]+$/.test(cpu) ? `${cpu} vCPU` : `${cpu} CPU`;
}

/** "2 vCPU · 8Gi memory": what each instance gets. */
export function resourcesLabel(r: ClusterResources): string {
  const memory = r.requests?.memory ?? r.limits?.memory;
  return [cpuLabel(r.requests?.cpu), memory && `${memory} memory`].filter(Boolean).join(' · ');
}

/** "M — 2 vCPU · 8Gi memory". */
export function sizeLabel(size: ClusterSize): string {
  const r = resourcesLabel(size.resources);
  return r ? `${size.displayName} — ${r}` : size.displayName;
}
