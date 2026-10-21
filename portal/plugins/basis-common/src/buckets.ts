/**
 * Buckets on the object store account COSI provisions with (the driver's
 * HyperStore keys): every one, also those nothing on the cluster uses any
 * more, such as the retained bucket of a deleted Project.
 *
 * - project: a Project's backup bucket (status.backup.bucket)
 * - cosi: a COSI Bucket object has it, without a Project (a BucketClaim of its own)
 * - orphaned: nothing on the cluster refers to it; the only state that can be deleted
 */
export type BucketState = 'project' | 'cosi' | 'orphaned';

export interface BucketUsage {
  objects: number;
  bytes: number;
  lastModified?: string;
  /** Counting stopped at the limit: objects and bytes are lower bounds. */
  truncated?: boolean;
}

export interface BucketSummary {
  name: string;
  createdAt?: string;
  state: BucketState;
  /** The Project using it (state project). */
  project?: string;
  /** For an orphaned project bucket, the Project it was made for (from its name). */
  formerProject?: string;
  /** The COSI Bucket object that has it (state project or cosi). */
  cosiBucket?: string;
  /** Unset when the account's keys can't list it. */
  usage?: BucketUsage;
  /** Why usage is missing. */
  usageError?: string;
}

/**
 * A folder in a bucket: the first path segment, or the first two under
 * "barman/" (one per PostgresCluster backup server).
 */
export interface BucketFolder extends BucketUsage {
  path: string;
  /** For a backup folder of the bucket's Project: the cluster, from its inventory. */
  cluster?: string;
  /** Whether that cluster still archives to it. */
  active?: boolean;
}

export interface BucketDetails {
  summary: BucketSummary;
  endpoint: string;
  /** Empty when the object store can't be read (storeError). */
  folders: BucketFolder[];
  /** Why the object store couldn't be read: the summary is then only what the cluster knows. */
  storeError?: string;
}

/**
 * The bucket list. Without an object store (not configured, or unreachable:
 * storeError) it holds only the buckets the cluster refers to, without usage,
 * and no orphaned ones.
 */
export interface BucketList {
  configured: boolean;
  items: BucketSummary[];
  storeError?: string;
}

/**
 * COSI's bucket names: <BucketClass><claim UID>. A Project's class is
 * project-<name>-backups, or, when that leaves the bucket name over S3's 63
 * characters, prj-<first 16 of name>-<6 hex of sha256(name)>.
 */
const UID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const PROJECT_BUCKET = new RegExp(`^project-([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)-backups${UID}$`);
const HASHED_PROJECT_BUCKET = new RegExp(`^prj-([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)-[0-9a-f]{6}${UID}$`);
const HASHED_PREFIX = 16;

/**
 * The Project a bucket was created for, from its name; undefined for other
 * buckets. From a hashed class only its first 16 characters are known, then
 * marked with a trailing "…".
 */
export function bucketProject(bucket: string): string | undefined {
  const full = PROJECT_BUCKET.exec(bucket)?.[1];
  if (full) return full;
  const prefix = HASHED_PROJECT_BUCKET.exec(bucket)?.[1];
  if (!prefix) return undefined;
  return prefix.length === HASHED_PREFIX ? `${prefix}…` : prefix;
}

/** Whether a bucket's name says it was made for this Project (see bucketProject). */
export function isProjectBucket(bucket: string, project: string): boolean {
  if (PROJECT_BUCKET.exec(bucket)?.[1] === project) return true;
  return HASHED_PROJECT_BUCKET.exec(bucket)?.[1] === project.slice(0, HASHED_PREFIX).replace(/-$/, '');
}

/** The folder an object key is counted under (see BucketFolder). */
export function bucketFolder(key: string): string {
  const parts = key.split('/');
  if (parts.length === 1) return '/';
  if (parts[0] === 'barman' && parts.length > 2) return `barman/${parts[1]}`;
  return parts[0];
}
