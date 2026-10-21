import {
  coreServices,
  createServiceFactory,
  createServiceRef,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { ConflictError, NotFoundError } from '@backstage/errors';
import {
  CoreV1Api,
  CustomObjectsApi,
  KubernetesObject,
  KubernetesObjectApi,
  PatchStrategy,
} from '@kubernetes/client-node';
import {
  GATEWAY_GROUP,
  GATEWAY_KIND,
  GATEWAY_PLURAL,
  GATEWAY_VERSION,
  GatewayKey,
  ModelGateway,
  summarizeGateway,
} from '@internal/backstage-plugin-basis-common';
import { basisKubernetesServiceRef, kubeCall, LocationKubeConfig } from './BasisKubernetesService';

const FIELD_MANAGER = 'backstage-basis';
const API = { group: GATEWAY_GROUP, version: GATEWAY_VERSION, plural: GATEWAY_PLURAL };

/**
 * ModelGateways (ai.cndev.nl) on the control plane, and their clients' API
 * keys, read from the copy in the active site's location (as caches' and
 * stacks' credentials are), so the portal needs no Secret access on the
 * control plane. Every write goes through the XR, so the API server validates
 * it against the XRD and the admission policies.
 */
export class GatewayService {
  readonly #custom: CustomObjectsApi;
  readonly #objects: KubernetesObjectApi;
  readonly #logger: LoggerService;

  constructor(options: { custom: CustomObjectsApi; objects: KubernetesObjectApi; logger: LoggerService }) {
    this.#custom = options.custom;
    this.#objects = options.objects;
    this.#logger = options.logger;
  }

  /** Every gateway (or one namespace's); empty when the ModelGateway API isn't installed. */
  async list(namespace?: string): Promise<ModelGateway[]> {
    try {
      const res = await kubeCall(() =>
        namespace
          ? this.#custom.listNamespacedCustomObject({ ...API, namespace })
          : this.#custom.listClusterCustomObject(API),
      );
      return (res.items ?? []) as ModelGateway[];
    } catch (e) {
      if (e instanceof NotFoundError) return [];
      throw e;
    }
  }

  async get(namespace: string, name: string): Promise<ModelGateway> {
    return (await kubeCall(
      () => this.#custom.getNamespacedCustomObject({ ...API, namespace, name }),
      `ModelGateway ${namespace}/${name}`,
    )) as ModelGateway;
  }

  /** The clients' API keys, from the keys Secret's copy in the active site's location. */
  async keys(namespace: string, name: string, kubeConfigFor: LocationKubeConfig): Promise<GatewayKey[]> {
    const summary = summarizeGateway(await this.get(namespace, name));
    const site = summary.sites.find(s => s.active) ?? summary.sites[0];
    if (!site?.location) throw new NotFoundError(`Gateway ${namespace}/${name} isn't placed yet`);
    const core = (await kubeConfigFor(site.location)).makeApiClient(CoreV1Api);
    const secret = await kubeCall(
      () => core.readNamespacedSecret({ namespace, name: summary.keysSecret }),
      `Secret ${namespace}/${summary.keysSecret} in ${site.location}`,
    );
    return Object.entries(secret.data ?? {})
      .map(([client, v]) => ({ client, key: Buffer.from(v, 'base64').toString('utf8') }))
      .sort((a, b) => a.client.localeCompare(b.client));
  }

  /** Creates or updates a gateway with server-side apply. */
  async apply(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string>;
    createOnly?: boolean;
    dryRun?: boolean;
  }): Promise<ModelGateway> {
    const { namespace, name, spec, labels, createOnly, dryRun } = options;
    if (createOnly) {
      const existing = await this.get(namespace, name).catch(e => {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      });
      if (existing) throw new ConflictError(`ModelGateway ${namespace}/${name} already exists`);
    }
    const body = {
      apiVersion: `${GATEWAY_GROUP}/${GATEWAY_VERSION}`,
      kind: GATEWAY_KIND,
      metadata: { name, namespace, labels: { ...labels, 'app.kubernetes.io/managed-by': 'backstage' } },
      spec,
    };
    const result = await kubeCall(() =>
      this.#objects.patch(body, undefined, dryRun ? 'All' : undefined, FIELD_MANAGER, true, PatchStrategy.ServerSideApply),
    );
    if (!dryRun) this.#logger.info(`Applied ModelGateway ${namespace}/${name}`);
    return result as unknown as ModelGateway;
  }

  /** Changes an existing gateway with a JSON merge patch (lists are replaced as a whole). */
  async patch(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string | null>;
    dryRun?: boolean;
  }): Promise<ModelGateway> {
    const { namespace, name, spec, labels, dryRun } = options;
    await this.get(namespace, name);
    const body = {
      apiVersion: `${GATEWAY_GROUP}/${GATEWAY_VERSION}`,
      kind: GATEWAY_KIND,
      metadata: { name, namespace, ...(labels ? { labels } : {}) },
      spec,
    };
    const result = await kubeCall(() =>
      this.#objects.patch(
        body as KubernetesObject,
        undefined,
        dryRun ? 'All' : undefined,
        FIELD_MANAGER,
        undefined,
        PatchStrategy.MergePatch,
      ),
    );
    if (!dryRun) this.#logger.info(`Patched ModelGateway ${namespace}/${name}: ${JSON.stringify(spec)}`);
    return result as unknown as ModelGateway;
  }

  async delete(namespace: string, name: string): Promise<void> {
    await kubeCall(
      () => this.#custom.deleteNamespacedCustomObject({ ...API, namespace, name, propagationPolicy: 'Foreground' }),
      `ModelGateway ${namespace}/${name}`,
    );
    this.#logger.info(`Deleted ModelGateway ${namespace}/${name}`);
  }
}

export const gatewayServiceRef = createServiceRef<GatewayService>({
  id: 'basis.gateways',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { logger: coreServices.logger, k8s: basisKubernetesServiceRef },
      factory: ({ logger, k8s }) =>
        new GatewayService({
          custom: k8s.kubeConfig.makeApiClient(CustomObjectsApi),
          objects: KubernetesObjectApi.makeApiClient(k8s.kubeConfig),
          logger,
        }),
    }),
});
