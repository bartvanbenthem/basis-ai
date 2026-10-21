import { createServiceFactory, createServiceRef } from '@backstage/backend-plugin-api';
import { CoreV1Api, CoreV1Event } from '@kubernetes/client-node';
import {
  AuditEntry,
  AuditLog,
  clusterLocations,
  CONTROL_PLANE,
  parsePgAuditLine,
  pgauditLog,
  PostgresCluster,
  Project,
  projectLocations,
} from '@internal/backstage-plugin-cnpg-common';
import { cnpgKubernetesServiceRef, kubeCall } from './CnpgKubernetesService';
import { locationServiceRef, withTimeout } from './LocationService';

/** Reading every instance's log can take a while; one slow location mustn't hang the page. */
const LOCATION_TIMEOUT_MS = 15_000;
/** Per instance; pgaudit's records are mixed with the rest of PostgreSQL's log. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** The calls made on the control plane and in a location; a CoreV1Api, or a fake in tests. */
export type AuditCore = Pick<CoreV1Api, 'listNamespacedEvent' | 'listNamespacedPod' | 'readNamespacedPodLog'>;

const toIso = (d?: Date | string) => (d instanceof Date ? d.toISOString() : d || undefined);

/** The cluster an object belongs to: CNPG and the composition name everything "<cluster>" or "<cluster>-...". */
function clusterOf(object: string | undefined, clusters: string[]): string | undefined {
  if (!object) return undefined;
  return clusters
    .filter(c => object === c || object.startsWith(`${c}-`))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * A project's audit trail (see AuditEntry): the Kubernetes events of its
 * namespace on the control plane and in each of its locations, and the
 * pgaudit records in the logs of its PostgreSQL instances. A location that
 * can't be read is reported in `unreachable`, not fatal.
 */
export class AuditService {
  readonly #getProject: (name: string) => Promise<Project>;
  readonly #listClusters: (namespace: string) => Promise<PostgresCluster[]>;
  readonly #controlPlane: AuditCore;
  readonly #coreFor: (location: string) => Promise<AuditCore>;

  constructor(options: {
    getProject: (name: string) => Promise<Project>;
    listClusters: (namespace: string) => Promise<PostgresCluster[]>;
    controlPlane: AuditCore;
    coreFor: (location: string) => Promise<AuditCore>;
  }) {
    this.#getProject = options.getProject;
    this.#listClusters = options.listClusters;
    this.#controlPlane = options.controlPlane;
    this.#coreFor = options.coreFor;
  }

  async list(options: { project: string; tailLines: number }): Promise<AuditLog> {
    const { project, tailLines } = options;
    const [resource, clusters] = await Promise.all([
      this.#getProject(project),
      this.#listClusters(project),
    ]);
    const names = clusters.map(c => c.metadata.name);
    const audited = clusters.map(c => ({
      name: c.metadata.name,
      // The size's settings, under the cluster's own (as the composition merges them).
      pgauditLog: pgauditLog({ ...c.status?.sizing?.parameters, ...c.spec.postgresql?.parameters }),
    }));

    // Every location the project or one of its clusters uses (a pinned site can outlive a project change).
    const locations = [
      ...new Set([...projectLocations(resource), ...clusters.flatMap(c => clusterLocations(c))]),
    ];
    const unreachable: NonNullable<AuditLog['unreachable']> = [];
    const guarded = async (location: string, read: () => Promise<AuditEntry[]>) => {
      try {
        return await withTimeout(read(), LOCATION_TIMEOUT_MS);
      } catch (e) {
        unreachable.push({ location, message: (e as Error).message });
        return [];
      }
    };

    const perSource = await Promise.all([
      guarded(CONTROL_PLANE, () => this.#controlPlaneEvents(project, names)),
      ...locations.map(location =>
        guarded(location, async () => {
          const core = await this.#coreFor(location);
          const pgaudit = clusters.filter(
            c =>
              audited.find(a => a.name === c.metadata.name)?.pgauditLog &&
              clusterLocations(c).includes(location),
          );
          const [events, ...records] = await Promise.all([
            this.#events(core, location, project, names),
            ...pgaudit.map(c => this.#pgaudit(core, location, project, c.metadata.name, tailLines)),
          ]);
          return [...events, ...records.flat()];
        }),
      ),
    ]);

    return {
      project,
      items: perSource.flat().sort((a, b) => (b.time ?? '').localeCompare(a.time ?? '')),
      clusters: audited,
      ...(unreachable.length ? { unreachable } : {}),
    };
  }

  /** The namespace's events on the control plane, and those of the (cluster-scoped) Project, which land in "default". */
  async #controlPlaneEvents(project: string, clusters: string[]): Promise<AuditEntry[]> {
    const [namespaced, own] = await Promise.all([
      this.#events(this.#controlPlane, CONTROL_PLANE, project, clusters),
      kubeCall(() =>
        this.#controlPlane.listNamespacedEvent({
          namespace: 'default',
          fieldSelector: `involvedObject.kind=Project,involvedObject.name=${project}`,
        }),
      ).then(res => res.items.map(e => toEntry(e, CONTROL_PLANE, clusters))),
    ]);
    return [...namespaced, ...own];
  }

  async #events(core: AuditCore, location: string, namespace: string, clusters: string[]): Promise<AuditEntry[]> {
    const res = await kubeCall(() => core.listNamespacedEvent({ namespace }));
    return res.items.map(e => toEntry(e, location, clusters));
  }

  /** pgaudit's records in the current log of each instance of a cluster in one location. */
  async #pgaudit(
    core: AuditCore,
    location: string,
    namespace: string,
    cluster: string,
    tailLines: number,
  ): Promise<AuditEntry[]> {
    const pods = await kubeCall(() =>
      core.listNamespacedPod({ namespace, labelSelector: `cnpg.io/cluster=${cluster},cnpg.io/podRole=instance` }),
    );
    const perPod = await Promise.all(
      pods.items.map(async pod => {
        const name = pod.metadata?.name ?? '';
        // A pod that just went away (failover, scale-down) has nothing to add.
        const text = await kubeCall(() =>
          core.readNamespacedPodLog({
            namespace,
            name,
            container: 'postgres',
            tailLines,
            limitBytes: MAX_LOG_BYTES,
          }),
        ).catch(() => '');
        return (text ?? '')
          .split('\n')
          .map(parsePgAuditLine)
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
          .map(r => ({ ...r, location, cluster, instance: r.instance ?? name }));
      }),
    );
    return perPod.flat();
  }
}

function toEntry(e: CoreV1Event, location: string, clusters: string[]): AuditEntry {
  const object = e.involvedObject;
  return {
    source: 'kubernetes',
    time: toIso(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp),
    location,
    cluster: clusterOf(object?.name, clusters),
    actor: e.reportingComponent || e.source?.component || e.reportingInstance || undefined,
    action: e.reason ?? '',
    object: object?.kind ? `${object.kind}/${object.name ?? ''}` : object?.name,
    message: e.message ?? '',
    type: e.type ?? 'Normal',
    count: e.count ?? e.series?.count ?? 1,
  };
}

export const auditServiceRef = createServiceRef<AuditService>({
  id: 'cnpg.audit',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: {
        k8s: cnpgKubernetesServiceRef,
        locations: locationServiceRef,
      },
      factory: ({ k8s, locations }) =>
        new AuditService({
          getProject: name => k8s.getProject(name),
          listClusters: namespace => k8s.list(namespace),
          controlPlane: k8s.kubeConfig.makeApiClient(CoreV1Api),
          coreFor: async location => (await locations.kubeConfig(location)).makeApiClient(CoreV1Api),
        }),
    }),
});
