import {
  createServiceFactory,
  createServiceRef,
  coreServices,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError } from '@backstage/errors';
import {
  CoreV1Api,
  V1PersistentVolume,
  V1PersistentVolumeClaim,
  V1Pod,
} from '@kubernetes/client-node';
import {
  clusterLocations,
  cnpgClaim,
  PostgresCluster,
  Project,
  projectLocations,
  VolumeList,
  VolumeState,
  VolumeSummary,
  volumeRole,
} from '@internal/backstage-plugin-cnpg-common';
import { cnpgKubernetesServiceRef, kubeCall } from './CnpgKubernetesService';
import { locationServiceRef, withTimeout } from './LocationService';

/** How long a node's volume usage (kubelet stats) is reused. */
const STATS_TTL_MS = 60_000;

/** The calls made in a location; a CoreV1Api, or a fake in tests. */
export type LocationCore = Pick<
  CoreV1Api,
  | 'listNamespacedPersistentVolumeClaim'
  | 'listPersistentVolume'
  | 'listNamespacedPod'
  | 'connectGetNodeProxyWithPath'
  | 'deleteNamespacedPersistentVolumeClaim'
  | 'deletePersistentVolume'
  | 'patchPersistentVolume'
>;

/** Usage per "<namespace>/<claim>" on one node. */
type NodeStats = Map<string, { usedBytes?: number; capacityBytes?: number }>;

interface Inventory {
  claims: V1PersistentVolumeClaim[];
  /** By name. */
  volumes: Map<string, V1PersistentVolume>;
  /** "<namespace>/<claim>" -> the pod mounting it. */
  mounts: Map<string, V1Pod>;
  /** Released volumes of CNPG claims in the project namespaces. */
  released: V1PersistentVolume[];
}

const key = (namespace: string, claim: string) => `${namespace}/${claim}`;
const toIso = (d?: Date | string) => (d instanceof Date ? d.toISOString() : d || undefined);

function driverOf(pv?: V1PersistentVolume): string | undefined {
  if (!pv?.spec) return undefined;
  if (pv.spec.csi?.driver) return pv.spec.csi.driver;
  if (pv.spec.local) return 'local';
  if (pv.spec.hostPath) return 'hostPath';
  if (pv.spec.nfs) return 'nfs';
  return undefined;
}

/**
 * The disks of PostgreSQL instances: in every location a Project uses, the
 * CNPG PersistentVolumeClaims in its namespace and the PersistentVolumes
 * behind them, read with that location's kubeconfig. A claim whose
 * PostgresCluster no longer runs there is orphaned, as is a released volume
 * (reclaim policy Retain) whose claim is gone; only those can be deleted.
 */
export class VolumeService {
  readonly #listProjects: () => Promise<Project[]>;
  readonly #listClusters: () => Promise<PostgresCluster[]>;
  readonly #coreFor: (location: string) => Promise<LocationCore>;
  readonly #logger: LoggerService;
  /** By "<location>/<node>". */
  readonly #stats = new Map<string, { value: NodeStats; at: number }>();

  constructor(options: {
    listProjects: () => Promise<Project[]>;
    listClusters: () => Promise<PostgresCluster[]>;
    coreFor: (location: string) => Promise<LocationCore>;
    logger: LoggerService;
  }) {
    this.#listProjects = options.listProjects;
    this.#listClusters = options.listClusters;
    this.#coreFor = options.coreFor;
    this.#logger = options.logger;
  }

  /** Every project's volumes, or one project's; an unreachable location is reported, not fatal. */
  async list(options: { project?: string } = {}): Promise<VolumeList> {
    const [projects, clusters] = await Promise.all([this.#listProjects(), this.#listClusters()]);
    const namespacesByLocation = new Map<string, string[]>();
    for (const p of projects) {
      if (options.project && p.metadata.name !== options.project) continue;
      for (const l of projectLocations(p)) {
        namespacesByLocation.set(l, [...(namespacesByLocation.get(l) ?? []), p.metadata.name]);
      }
    }
    const unreachable: NonNullable<VolumeList['unreachable']> = [];
    const perLocation = await Promise.all(
      [...namespacesByLocation].map(async ([location, namespaces]) => {
        try {
          return await withTimeout(this.#locationVolumes(location, namespaces, clusters));
        } catch (e) {
          unreachable.push({ location, message: (e as Error).message });
          return [];
        }
      }),
    );
    const items = perLocation
      .flat()
      .sort(
        (a, b) =>
          a.project.localeCompare(b.project) ||
          a.location.localeCompare(b.location) ||
          a.claim.localeCompare(b.claim) ||
          (a.volume ?? '').localeCompare(b.volume ?? ''),
      );
    return { items, ...(unreachable.length ? { unreachable } : {}) };
  }

  /**
   * Deletes an orphaned claim with the disk behind it: a volume that would
   * be retained is switched to Delete first, so its storage goes too.
   */
  async deleteClaim(location: string, namespace: string, claim: string): Promise<void> {
    const volume = await this.#find(location, namespace, v => v.claim === claim && v.state !== 'released');
    if (!volume) throw new NotFoundError(`Volume claim ${namespace}/${claim} not found in ${location}`);
    this.#assertOrphaned(volume);
    const core = await this.#coreFor(location);
    if (volume.volume && volume.reclaimPolicy !== 'Delete') await this.#reclaim(core, volume.volume);
    this.#logger.info(`Deleting orphaned volume claim ${namespace}/${claim} in ${location} (volume ${volume.volume ?? 'none'})`);
    await kubeCall(
      () => core.deleteNamespacedPersistentVolumeClaim({ namespace, name: claim }),
      `Volume claim ${namespace}/${claim} in ${location}`,
    );
  }

  /**
   * Deletes a released volume (its claim is gone) with its storage: Kubernetes
   * reclaims it once its policy is Delete. One already set to Delete that
   * stayed released (its reclaim failed) is deleted directly.
   */
  async deleteVolume(location: string, name: string): Promise<void> {
    const projects = await this.#listProjects();
    const namespaces = projects.filter(p => projectLocations(p).includes(location)).map(p => p.metadata.name);
    if (!namespaces.length) throw new NotFoundError(`No project uses location ${location}`);
    const items = await this.#locationVolumes(location, namespaces, await this.#listClusters());
    const volume = items.find(v => v.volume === name);
    if (!volume) throw new NotFoundError(`Volume ${name} not found in ${location}`);
    this.#assertOrphaned(volume);
    if (volume.state !== 'released') {
      throw new ConflictError(`Volume ${name} still has its claim ${volume.project}/${volume.claim}; delete that instead`);
    }
    const core = await this.#coreFor(location);
    this.#logger.info(`Deleting released volume ${name} in ${location} (was ${volume.project}/${volume.claim})`);
    if (volume.reclaimPolicy !== 'Delete') {
      await this.#reclaim(core, name);
    } else {
      await kubeCall(() => core.deletePersistentVolume({ name }), `Volume ${name} in ${location}`);
    }
  }

  #assertOrphaned(volume: VolumeSummary) {
    if (volume.state !== 'in-use') return;
    const user = volume.pod
      ? `pod ${volume.pod} mounts it`
      : `PostgresCluster ${volume.project}/${volume.cluster} still runs in ${volume.location}`;
    throw new ConflictError(`Volume ${volume.project}/${volume.claim} is in use: ${user}`);
  }

  async #reclaim(core: LocationCore, name: string) {
    await kubeCall(
      () =>
        core.patchPersistentVolume({
          name,
          body: [{ op: 'replace', path: '/spec/persistentVolumeReclaimPolicy', value: 'Delete' }],
        }),
      `Volume ${name}`,
    );
  }

  async #find(location: string, namespace: string, match: (v: VolumeSummary) => boolean) {
    const project = (await this.#listProjects()).find(p => p.metadata.name === namespace);
    if (!project || !projectLocations(project).includes(location)) {
      throw new NotFoundError(`Project ${namespace} doesn't use location ${location}`);
    }
    const items = await this.#locationVolumes(location, [namespace], await this.#listClusters());
    return items.find(match);
  }

  async #locationVolumes(
    location: string,
    namespaces: string[],
    clusters: PostgresCluster[],
  ): Promise<VolumeSummary[]> {
    const core = await this.#coreFor(location);
    const inventory = await this.#inventory(core, namespaces);
    // A PostgresCluster being deleted still owns its claims until CNPG cleans up.
    const running = new Set(
      clusters
        .filter(c => clusterLocations(c).includes(location))
        .map(c => key(c.metadata.namespace, c.metadata.name)),
    );
    const stats = await this.#nodeStats(core, location, [
      ...new Set([...inventory.mounts.values()].map(p => p.spec?.nodeName).filter((n): n is string => Boolean(n))),
    ]);

    const claims = inventory.claims.map((c): VolumeSummary => {
      const namespace = c.metadata?.namespace ?? '';
      const claim = c.metadata?.name ?? '';
      const labels = c.metadata?.labels ?? {};
      const cluster = labels['cnpg.io/cluster'];
      const pv = c.spec?.volumeName ? inventory.volumes.get(c.spec.volumeName) : undefined;
      const pod = inventory.mounts.get(key(namespace, claim));
      const node = pod?.spec?.nodeName;
      const usage = node ? stats.get(node)?.get(key(namespace, claim)) : undefined;
      const inUse = Boolean(pod) || running.has(key(namespace, cluster ?? ''));
      const capacity = c.status?.capacity?.storage;
      const requested = c.spec?.resources?.requests?.storage;
      const state: VolumeState = inUse ? 'in-use' : 'orphaned';
      return {
        location,
        project: namespace,
        claim,
        volume: c.spec?.volumeName || undefined,
        state,
        cluster,
        instance: labels['cnpg.io/instanceName'],
        role: volumeRole(labels['cnpg.io/pvcRole']),
        tablespace: labels['cnpg.io/tablespaceName'],
        phase: c.status?.phase ?? 'Unknown',
        capacity,
        requested,
        ...usage,
        storageClass: c.spec?.storageClassName,
        reclaimPolicy: pv?.spec?.persistentVolumeReclaimPolicy,
        driver: driverOf(pv),
        pod: pod?.metadata?.name,
        node,
        resizing:
          (c.status?.conditions ?? []).some(
            x => (x.type === 'Resizing' || x.type === 'FileSystemResizePending') && x.status === 'True',
          ) || undefined,
        createdAt: toIso(c.metadata?.creationTimestamp),
      };
    });

    const released = inventory.released.map((pv): VolumeSummary => {
      const ref = pv.spec!.claimRef!;
      const parsed = cnpgClaim(ref.name ?? '');
      return {
        location,
        project: ref.namespace ?? '',
        claim: ref.name ?? '',
        volume: pv.metadata?.name,
        state: 'released',
        cluster: parsed?.cluster,
        instance: parsed?.instance,
        role: parsed?.role,
        tablespace: parsed?.tablespace,
        phase: pv.status?.phase ?? 'Released',
        capacity: pv.spec?.capacity?.storage,
        storageClass: pv.spec?.storageClassName,
        reclaimPolicy: pv.spec?.persistentVolumeReclaimPolicy,
        driver: driverOf(pv),
        createdAt: toIso(pv.metadata?.creationTimestamp),
      };
    });
    return [...claims, ...released];
  }

  async #inventory(core: LocationCore, namespaces: string[]): Promise<Inventory> {
    const [claimLists, podLists, volumeList] = await Promise.all([
      Promise.all(
        namespaces.map(namespace =>
          kubeCall(() => core.listNamespacedPersistentVolumeClaim({ namespace, labelSelector: 'cnpg.io/cluster' })),
        ),
      ),
      Promise.all(namespaces.map(namespace => kubeCall(() => core.listNamespacedPod({ namespace })))),
      kubeCall(() => core.listPersistentVolume({})),
    ]);
    const claims = claimLists.flatMap(l => l.items);
    const volumes = new Map(volumeList.items.map(v => [v.metadata?.name ?? '', v]));
    const mounts = new Map<string, V1Pod>();
    for (const pod of podLists.flatMap(l => l.items)) {
      if (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') continue;
      for (const v of pod.spec?.volumes ?? []) {
        if (v.persistentVolumeClaim) mounts.set(key(pod.metadata?.namespace ?? '', v.persistentVolumeClaim.claimName), pod);
      }
    }
    const inProject = new Set(namespaces);
    const released = volumeList.items.filter(
      v =>
        v.status?.phase === 'Released' &&
        inProject.has(v.spec?.claimRef?.namespace ?? '') &&
        cnpgClaim(v.spec?.claimRef?.name ?? ''),
    );
    return { claims, volumes, mounts, released };
  }

  /** Volume usage from each node's kubelet (/stats/summary); a node that can't be read just has none. */
  async #nodeStats(core: LocationCore, location: string, nodes: string[]): Promise<Map<string, NodeStats>> {
    const result = new Map<string, NodeStats>();
    await Promise.all(
      nodes.map(async node => {
        const cacheKey = `${location}/${node}`;
        const hit = this.#stats.get(cacheKey);
        if (hit && Date.now() - hit.at < STATS_TTL_MS) {
          result.set(node, hit.value);
          return;
        }
        try {
          const raw = await withTimeout(core.connectGetNodeProxyWithPath({ name: node, path: 'stats/summary' }), 5_000);
          const summary = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
            pods?: Array<{ volume?: Array<{ usedBytes?: number; capacityBytes?: number; pvcRef?: { name?: string; namespace?: string } }> }>;
          };
          const value: NodeStats = new Map();
          for (const p of summary.pods ?? []) {
            for (const v of p.volume ?? []) {
              if (v.pvcRef?.name && v.pvcRef.namespace) {
                value.set(key(v.pvcRef.namespace, v.pvcRef.name), { usedBytes: v.usedBytes, capacityBytes: v.capacityBytes });
              }
            }
          }
          this.#stats.set(cacheKey, { value, at: Date.now() });
          result.set(node, value);
        } catch (e) {
          this.#logger.debug(`No volume stats from node ${node} in ${location}: ${(e as Error).message}`);
        }
      }),
    );
    return result;
  }
}

export const volumeServiceRef = createServiceRef<VolumeService>({
  id: 'cnpg.volumes',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: {
        logger: coreServices.logger,
        k8s: cnpgKubernetesServiceRef,
        locations: locationServiceRef,
      },
      factory: ({ logger, k8s, locations }) =>
        new VolumeService({
          listProjects: () => k8s.listProjects(),
          listClusters: () => k8s.list(),
          coreFor: async location => (await locations.kubeConfig(location)).makeApiClient(CoreV1Api),
          logger,
        }),
    }),
});
