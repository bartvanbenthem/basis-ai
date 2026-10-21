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
  GenAIStack,
  STACK_GROUP,
  STACK_KIND,
  STACK_PLURAL,
  STACK_VERSION,
  StackConnection,
  summarizeStack,
} from '@internal/backstage-plugin-basis-common';
import { basisKubernetesServiceRef, kubeCall, LocationKubeConfig } from './BasisKubernetesService';

const FIELD_MANAGER = 'backstage-basis';
const API = { group: STACK_GROUP, version: STACK_VERSION, plural: STACK_PLURAL };

/**
 * GenAIStacks (ai.cndev.nl) on the control plane, and the wiring of their
 * active site in its location. Every write goes through the XR, so the API
 * server validates it against the XRD and the admission policies.
 */
export class StackService {
  readonly #custom: CustomObjectsApi;
  readonly #objects: KubernetesObjectApi;
  readonly #logger: LoggerService;

  constructor(options: { custom: CustomObjectsApi; objects: KubernetesObjectApi; logger: LoggerService }) {
    this.#custom = options.custom;
    this.#objects = options.objects;
    this.#logger = options.logger;
  }

  /** Every stack (or one namespace's); empty when the GenAIStack API isn't installed. */
  async list(namespace?: string): Promise<GenAIStack[]> {
    try {
      const res = await kubeCall(() =>
        namespace
          ? this.#custom.listNamespacedCustomObject({ ...API, namespace })
          : this.#custom.listClusterCustomObject(API),
      );
      return (res.items ?? []) as GenAIStack[];
    } catch (e) {
      if (e instanceof NotFoundError) return [];
      throw e;
    }
  }

  async get(namespace: string, name: string): Promise<GenAIStack> {
    return (await kubeCall(
      () => this.#custom.getNamespacedCustomObject({ ...API, namespace, name }),
      `GenAIStack ${namespace}/${name}`,
    )) as GenAIStack;
  }

  /** The active site's connection Secret, as key/value pairs (passwords included). */
  async connection(namespace: string, name: string, kubeConfigFor: LocationKubeConfig): Promise<StackConnection> {
    const summary = summarizeStack(await this.get(namespace, name));
    const site = summary.sites.find(s => s.active) ?? summary.sites[0];
    if (!site?.location) throw new NotFoundError(`Stack ${namespace}/${name} isn't placed yet`);
    const core = (await kubeConfigFor(site.location)).makeApiClient(CoreV1Api);
    const secret = await kubeCall(
      () => core.readNamespacedSecret({ namespace, name: summary.connectionSecret }),
      `Secret ${namespace}/${summary.connectionSecret} in ${site.location}`,
    );
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(secret.data ?? {})) {
      values[k] = Buffer.from(v, 'base64').toString('utf8');
    }
    return { site: site.site, location: site.location, values };
  }

  /** Creates or updates a stack with server-side apply. */
  async apply(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string>;
    createOnly?: boolean;
    dryRun?: boolean;
  }): Promise<GenAIStack> {
    const { namespace, name, spec, labels, createOnly, dryRun } = options;
    if (createOnly) {
      const existing = await this.get(namespace, name).catch(e => {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      });
      if (existing) throw new ConflictError(`GenAIStack ${namespace}/${name} already exists`);
    }
    const body = {
      apiVersion: `${STACK_GROUP}/${STACK_VERSION}`,
      kind: STACK_KIND,
      metadata: { name, namespace, labels: { ...labels, 'app.kubernetes.io/managed-by': 'backstage' } },
      spec,
    };
    const result = await kubeCall(() =>
      this.#objects.patch(body, undefined, dryRun ? 'All' : undefined, FIELD_MANAGER, true, PatchStrategy.ServerSideApply),
    );
    if (!dryRun) this.#logger.info(`Applied GenAIStack ${namespace}/${name}`);
    return result as unknown as GenAIStack;
  }

  /** Changes an existing stack with a JSON merge patch. */
  async patch(options: {
    namespace: string;
    name: string;
    spec: Record<string, unknown>;
    labels?: Record<string, string | null>;
    dryRun?: boolean;
  }): Promise<GenAIStack> {
    const { namespace, name, spec, labels, dryRun } = options;
    await this.get(namespace, name);
    const body = {
      apiVersion: `${STACK_GROUP}/${STACK_VERSION}`,
      kind: STACK_KIND,
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
    if (!dryRun) this.#logger.info(`Patched GenAIStack ${namespace}/${name}: ${JSON.stringify(spec)}`);
    return result as unknown as GenAIStack;
  }

  /**
   * Deletes a stack, turning its deletionProtection off first (the admission
   * policy refuses the delete otherwise). Its database goes with it.
   */
  async delete(namespace: string, name: string): Promise<void> {
    const stack = await this.get(namespace, name);
    if (stack.spec.deletionProtection !== false) {
      await this.patch({ namespace, name, spec: { deletionProtection: false } });
    }
    await kubeCall(
      () => this.#custom.deleteNamespacedCustomObject({ ...API, namespace, name, propagationPolicy: 'Foreground' }),
      `GenAIStack ${namespace}/${name}`,
    );
    this.#logger.info(`Deleted GenAIStack ${namespace}/${name}`);
  }
}

export const stackServiceRef = createServiceRef<StackService>({
  id: 'basis.stacks',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { logger: coreServices.logger, k8s: basisKubernetesServiceRef },
      factory: ({ logger, k8s }) =>
        new StackService({
          custom: k8s.kubeConfig.makeApiClient(CustomObjectsApi),
          objects: KubernetesObjectApi.makeApiClient(k8s.kubeConfig),
          logger,
        }),
    }),
});
