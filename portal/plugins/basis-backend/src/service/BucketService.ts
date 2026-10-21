import {
  coreServices,
  createServiceFactory,
  createServiceRef,
  LoggerService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '@backstage/errors';
import { CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';
import {
  BucketDetails,
  BucketFolder,
  bucketFolder,
  BucketList,
  bucketProject,
  isProjectBucket,
  BucketSummary,
  BucketUsage,
  Project,
} from '@internal/backstage-plugin-basis-common';
import { basisKubernetesServiceRef, kubeCall } from './BasisKubernetesService';
import { ObjectStore, S3ObjectStore, StoredObject } from './objectStore';

/** COSI's cluster-scoped Bucket objects, one per bucket it provisioned. */
const COSI_BUCKET_API = { group: 'objectstorage.k8s.io', version: 'v1alpha1', plural: 'buckets' };
/** The keys in the driver's credentials Secret (cloudian-cosi-driver chart). */
const ACCESS_KEY = 'S3_ACCESS_KEY';
const SECRET_KEY = 'S3_SECRET_KEY';
/** Objects counted per bucket; a bigger bucket shows its usage as "at least". */
const COUNT_LIMIT = 100_000;
/** How long a bucket's usage (and the store's keys) are reused. */
const CACHE_TTL_MS = 60_000;
const NOT_CONFIGURED =
  'No object store configured: set basis.buckets (endpoint and the COSI driver credentials Secret) in app-config';

export interface BucketsConfig {
  endpoint: string;
  region: string;
  secret: { namespace: string; name: string };
}

/** Builds the store client from the driver's keys; tests pass a fake. */
export type StoreFactory = (
  config: BucketsConfig,
  keys: { accessKeyId: string; secretAccessKey: string },
) => ObjectStore;

interface CosiBucket {
  metadata: { name: string; creationTimestamp?: string };
  spec?: { bucketClaim?: { namespace?: string; name?: string } };
  status?: { bucketID?: string };
}

interface Refs {
  /** Bucket name -> Project using it. */
  projects: Map<string, Project>;
  /** Bucket name -> COSI Bucket object. */
  cosi: Map<string, CosiBucket>;
  /** Every bucket the cluster refers to, with when its COSI Bucket was made. */
  known: Map<string, string | undefined>;
}

/** The store's buckets, or why they can't be listed. */
type Listing =
  | { store: ObjectStore; buckets: Array<{ name: string; createdAt?: string }> }
  | { error: string };

function usageOf(objects: StoredObject[], truncated: boolean): BucketUsage {
  let bytes = 0;
  let lastModified: string | undefined;
  for (const o of objects) {
    bytes += o.size;
    if (o.lastModified && (!lastModified || o.lastModified > lastModified)) lastModified = o.lastModified;
  }
  return { objects: objects.length, bytes, lastModified, ...(truncated ? { truncated } : {}) };
}

/**
 * Every bucket on the object store account COSI provisions with, read with
 * the COSI driver's own keys (its credentials Secret). Each is matched to the
 * Project or COSI Bucket object that uses it; the rest are orphaned, and only
 * those can be deleted. When the store can't be read, the buckets the cluster
 * refers to are still listed, without usage.
 */
export class BucketService {
  readonly #core?: CoreV1Api;
  readonly #custom?: CustomObjectsApi;
  readonly #listProjects: () => Promise<Project[]>;
  readonly #config?: BucketsConfig;
  readonly #logger: LoggerService;
  readonly #storeFactory: StoreFactory;
  #store?: { value: ObjectStore; at: number };
  readonly #usage = new Map<string, { value: BucketUsage; at: number }>();

  constructor(options: {
    core?: CoreV1Api;
    custom?: CustomObjectsApi;
    listProjects: () => Promise<Project[]>;
    config?: BucketsConfig;
    logger: LoggerService;
    storeFactory?: StoreFactory;
  }) {
    this.#core = options.core;
    this.#custom = options.custom;
    this.#listProjects = options.listProjects;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#storeFactory =
      options.storeFactory ?? ((c, keys) => new S3ObjectStore({ endpoint: c.endpoint, region: c.region, ...keys }));
  }

  get configured(): boolean {
    return Boolean(this.#config);
  }

  async list(): Promise<BucketList> {
    const [listing, refs] = await Promise.all([this.#listing(), this.#refs()]);
    const configured = this.configured;
    if ('error' in listing) {
      const items = [...refs.known].map(([name, createdAt]) => this.#summary(name, createdAt, refs));
      return { configured, items: items.sort((a, b) => a.name.localeCompare(b.name)), storeError: listing.error };
    }
    const { store, buckets } = listing;
    const summaries = await Promise.all(
      buckets.map(async b => {
        const summary = this.#summary(b.name, b.createdAt, refs);
        try {
          summary.usage = await this.#cachedUsage(store, b.name);
        } catch (e) {
          summary.usageError = (e as Error).message;
        }
        return summary;
      }),
    );
    return { configured, items: summaries.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async get(name: string): Promise<BucketDetails> {
    const [listing, refs] = await Promise.all([this.#listing(), this.#refs()]);
    if ('error' in listing) {
      if (!refs.known.has(name)) throw new ServiceUnavailableError(listing.error);
      return {
        summary: this.#summary(name, refs.known.get(name), refs),
        endpoint: this.#config?.endpoint ?? '',
        folders: [],
        storeError: listing.error,
      };
    }
    const { store, buckets } = listing;
    const bucket = buckets.find(b => b.name === name);
    if (!bucket) throw new NotFoundError(`Bucket ${name} not found`);
    const summary = this.#summary(name, bucket.createdAt, refs);
    const { objects, truncated } = await store.listObjects(name, COUNT_LIMIT);
    summary.usage = usageOf(objects, truncated);
    this.#usage.set(name, { value: summary.usage, at: Date.now() });

    const byFolder = new Map<string, StoredObject[]>();
    for (const o of objects) {
      const path = bucketFolder(o.key);
      byFolder.set(path, [...(byFolder.get(path) ?? []), o]);
    }
    const servers = (summary.project && refs.projects.get(name)?.status?.backup?.servers) || [];
    const folders: BucketFolder[] = [...byFolder.entries()]
      .map(([path, items]) => {
        const server = path.startsWith('barman/')
          ? servers.find(s => s.serverName === path.slice('barman/'.length))
          : undefined;
        return {
          path,
          ...usageOf(items, truncated),
          ...(server ? { cluster: server.cluster, active: Boolean(server.active) } : {}),
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    return { summary, endpoint: store.endpoint, folders };
  }

  /** Deletes an orphaned bucket and everything in it. */
  async delete(name: string): Promise<void> {
    const store = await this.#objectStore();
    const [buckets, refs] = await Promise.all([store.listBuckets(), this.#refs()]);
    if (!buckets.some(b => b.name === name)) throw new NotFoundError(`Bucket ${name} not found`);
    const summary = this.#summary(name, undefined, refs);
    if (summary.state === 'project') {
      throw new ConflictError(`Bucket ${name} is project ${summary.project}'s backup bucket; it can go once the project is deleted`);
    }
    if (summary.state === 'cosi') {
      throw new ConflictError(
        `COSI Bucket ${summary.cosiBucket} still has bucket ${name}; delete its BucketClaim instead, so COSI removes it`,
      );
    }
    this.#logger.info(`Deleting orphaned bucket ${name} and its contents`);
    await store.deleteBucket(name);
    this.#usage.delete(name);
  }

  #summary(name: string, createdAt: string | undefined, refs: Refs): BucketSummary {
    const project = refs.projects.get(name);
    const cosi = refs.cosi.get(name);
    const base = { name, createdAt, ...(cosi ? { cosiBucket: cosi.metadata.name } : {}) };
    if (project) return { ...base, state: 'project', project: project.metadata.name };
    if (cosi) return { ...base, state: 'cosi' };
    return { ...base, state: 'orphaned', formerProject: bucketProject(name) };
  }

  /** The store's buckets; an unconfigured or unreachable store is an error message, not a failure. */
  async #listing(): Promise<Listing> {
    if (!this.#config) return { error: NOT_CONFIGURED };
    try {
      const store = await this.#objectStore();
      return { store, buckets: await store.listBuckets() };
    } catch (e) {
      const error = `Object store ${this.#config.endpoint} can't be read: ${(e as Error).message}`;
      this.#logger.warn(error);
      return { error };
    }
  }

  async #refs(): Promise<Refs> {
    const [projects, cosiBuckets] = await Promise.all([this.#listProjects(), this.#cosiBuckets()]);
    const byName = new Map(projects.map(p => [p.metadata.name, p]));
    const refs: Refs = { projects: new Map(), cosi: new Map(), known: new Map() };
    for (const b of cosiBuckets) {
      for (const id of [b.metadata.name, b.status?.bucketID]) if (id) refs.cosi.set(id, b);
      refs.known.set(b.status?.bucketID ?? b.metadata.name, b.metadata.creationTimestamp);
      // A Project whose status doesn't name its bucket yet (or any more) still owns its claim's.
      const claimProject = b.spec?.bucketClaim?.namespace && byName.get(b.spec.bucketClaim.namespace);
      if (claimProject && isProjectBucket(b.metadata.name, claimProject.metadata.name)) {
        refs.projects.set(b.status?.bucketID ?? b.metadata.name, claimProject);
      }
    }
    for (const p of projects) {
      const bucket = p.status?.backup?.bucket;
      if (!bucket) continue;
      refs.projects.set(bucket, p);
      if (!refs.known.has(bucket)) refs.known.set(bucket, refs.cosi.get(bucket)?.metadata.creationTimestamp);
    }
    return refs;
  }

  async #cosiBuckets(): Promise<CosiBucket[]> {
    if (!this.#custom) return [];
    try {
      const res = await kubeCall(() => this.#custom!.listClusterCustomObject(COSI_BUCKET_API));
      return ((res as { items?: CosiBucket[] }).items ?? []);
    } catch (e) {
      // No COSI CRDs: nothing on the cluster refers to any bucket.
      if (e instanceof NotFoundError) return [];
      throw e;
    }
  }

  async #cachedUsage(store: ObjectStore, bucket: string): Promise<BucketUsage> {
    const hit = this.#usage.get(bucket);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const { objects, truncated } = await store.listObjects(bucket, COUNT_LIMIT);
    const value = usageOf(objects, truncated);
    this.#usage.set(bucket, { value, at: Date.now() });
    return value;
  }

  /** The store with the driver's current keys; re-read now and then, so a key rotation is picked up. */
  async #objectStore(): Promise<ObjectStore> {
    if (!this.#config) throw new ServiceUnavailableError(NOT_CONFIGURED);
    if (this.#store && Date.now() - this.#store.at < CACHE_TTL_MS) return this.#store.value;
    const { namespace, name } = this.#config.secret;
    const secret = await kubeCall(
      () => this.#core!.readNamespacedSecret({ namespace, name }),
      `Secret ${namespace}/${name} (the COSI driver's credentials)`,
    );
    const key = (k: string) => {
      const v = secret.data?.[k];
      if (!v) throw new ServiceUnavailableError(`Secret ${namespace}/${name} has no ${k}`);
      return Buffer.from(v, 'base64').toString('utf8');
    };
    const value = this.#storeFactory(this.#config, {
      accessKeyId: key(ACCESS_KEY),
      secretAccessKey: key(SECRET_KEY),
    });
    this.#store = { value, at: Date.now() };
    return value;
  }
}

export function bucketsConfig(config: RootConfigService): BucketsConfig | undefined {
  const c = config.getOptionalConfig('basis.buckets');
  const endpoint = c?.getOptionalString('endpoint');
  if (!c || !endpoint) return undefined;
  return {
    endpoint,
    region: c.getOptionalString('region') ?? 'us-east-1',
    secret: {
      namespace: c.getOptionalString('credentialsSecret.namespace') ?? 'cloudian-cosi',
      name: c.getOptionalString('credentialsSecret.name') ?? 'cloudian-cosi-secret',
    },
  };
}

export const bucketServiceRef = createServiceRef<BucketService>({
  id: 'basis.buckets',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        k8s: basisKubernetesServiceRef,
      },
      factory: ({ config, logger, k8s }) =>
        new BucketService({
          core: k8s.kubeConfig.makeApiClient(CoreV1Api),
          custom: k8s.kubeConfig.makeApiClient(CustomObjectsApi),
          listProjects: () => k8s.listProjects(),
          config: bucketsConfig(config),
          logger,
        }),
    }),
});
