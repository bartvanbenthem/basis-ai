/**
 * The disks of PostgreSQL instances: CNPG's PersistentVolumeClaims in each
 * Project's namespace, in every location the project uses, with the
 * PersistentVolume behind each.
 *
 * - in-use: its PostgresCluster still runs in that location (or a pod mounts it)
 * - orphaned: the claim of a PostgresCluster that no longer exists there
 * - released: a PersistentVolume (reclaim policy Retain) whose claim is gone
 *
 * Only orphaned and released volumes can be deleted.
 */
export type VolumeState = 'in-use' | 'orphaned' | 'released';

/** What the volume holds (CNPG's cnpg.io/pvcRole label). */
export type VolumeRole = 'data' | 'wal' | 'tablespace';

export interface VolumeSummary {
  location: string;
  /** The Project (= namespace). */
  project: string;
  /** The PersistentVolumeClaim; for a released volume, the claim it had. */
  claim: string;
  /** The PersistentVolume; unset while the claim is pending. */
  volume?: string;
  state: VolumeState;
  /** The PostgresCluster it belongs (or belonged) to. */
  cluster?: string;
  /** The instance (pod) it belongs to, e.g. orders-db-1. */
  instance?: string;
  role?: VolumeRole;
  tablespace?: string;
  /** The claim's phase (Bound, Pending, Lost); the volume's for a released one. */
  phase: string;
  /** Provisioned size, e.g. "20Gi". */
  capacity?: string;
  /** Requested size; differs from capacity while it grows. */
  requested?: string;
  /** From the kubelet of the node it's mounted on; unset when not mounted or unreadable. */
  usedBytes?: number;
  capacityBytes?: number;
  storageClass?: string;
  /** What happens to the disk when its claim goes: Delete or Retain. */
  reclaimPolicy?: string;
  /** CSI driver (or volume plugin) providing the disk. */
  driver?: string;
  /** The pod that mounts it, and its node. */
  pod?: string;
  node?: string;
  /** A resize is still in progress. */
  resizing?: boolean;
  createdAt?: string;
}

export interface VolumeList {
  items: VolumeSummary[];
  /** Locations whose volumes couldn't be read. */
  unreachable?: Array<{ location: string; message: string }>;
}

const ROLES: Record<string, VolumeRole> = {
  PG_DATA: 'data',
  PG_WAL: 'wal',
  PG_TABLESPACE: 'tablespace',
};

/** CNPG's cnpg.io/pvcRole label as a VolumeRole. */
export function volumeRole(label?: string): VolumeRole | undefined {
  return label ? ROLES[label] : undefined;
}

/** CNPG's claim names: <instance> (data), <instance>-wal, <instance>-tbs-<tablespace>; instance = <cluster>-<n>. */
const CNPG_CLAIM = /^([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)-([0-9]+)(?:-(wal)|-tbs-([-a-z0-9_]+))?$/;

/**
 * Cluster, instance and role from a CNPG claim name, for a released volume
 * whose claim (and its labels) is gone; undefined for other names.
 */
export function cnpgClaim(
  name: string,
): { cluster: string; instance: string; role: VolumeRole; tablespace?: string } | undefined {
  const m = CNPG_CLAIM.exec(name);
  if (!m) return undefined;
  const [, cluster, n, wal, tablespace] = m;
  let role: VolumeRole = 'data';
  if (wal) role = 'wal';
  else if (tablespace) role = 'tablespace';
  return {
    cluster,
    instance: `${cluster}-${n}`,
    role,
    ...(tablespace ? { tablespace } : {}),
  };
}

/** Whether a volume in this state may be deleted. */
export function isOrphanedVolume(state: VolumeState): boolean {
  return state !== 'in-use';
}

const UNITS: Record<string, number> = {
  '': 1,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
};

/** A Kubernetes storage quantity in bytes ("20Gi" -> 21474836480); undefined when unparsable. */
export function quantityBytes(quantity?: string): number | undefined {
  const m = /^([0-9.]+)(Ki|Mi|Gi|Ti|Pi|k|K|M|G|T|P)?$/.exec(quantity ?? '');
  if (!m) return undefined;
  return Math.round(parseFloat(m[1]) * UNITS[m[2] ?? '']);
}
