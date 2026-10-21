import {
  coreServices,
  createServiceFactory,
  createServiceRef,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import { KubernetesObjectApi, PatchStrategy } from '@kubernetes/client-node';
import { PROVIDER_KEY_FIELD, providerKeySecretName } from '@internal/backstage-plugin-basis-common';
import { basisKubernetesServiceRef, kubeCall } from './BasisKubernetesService';

const FIELD_MANAGER = 'backstage-basis';

/** The object a key belongs to: the Secret goes with it (owner reference). */
export interface KeyOwner {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; uid?: string };
}

type Models = Array<{ name?: unknown; apiKeySecretRef?: { name?: unknown; key?: unknown } }>;

/**
 * Provider API keys entered in the portal's forms. They never go into a
 * GenAIStack's or ModelGateway's spec (anyone who may read it would read
 * them): the form sends them next to the spec, keyed by model name, and the
 * spec references the Secret this writes in the project namespace on the
 * control plane, from where the platform copies the key to the locations.
 */
export class ProviderKeyService {
  readonly #objects: KubernetesObjectApi;
  readonly #logger: LoggerService;

  constructor(options: { objects: KubernetesObjectApi; logger: LoggerService }) {
    this.#objects = options.objects;
    this.#logger = options.logger;
  }

  /**
   * Checks that every key belongs to a model in `models` that references the
   * Secret the portal writes for it, so a key can't be written anywhere else.
   */
  check(owner: string, models: Models | undefined, keys: Record<string, string> | undefined) {
    for (const model of Object.keys(keys ?? {})) {
      const m = (models ?? []).find(x => x.name === model);
      const ref = m?.apiKeySecretRef;
      if (!m || ref?.name !== providerKeySecretName(owner, model) || (ref.key ?? PROVIDER_KEY_FIELD) !== PROVIDER_KEY_FIELD) {
        throw new InputError(
          `A key for model ${model} needs that model with apiKeySecretRef {name: ${providerKeySecretName(owner, model)}, key: ${PROVIDER_KEY_FIELD}}`,
        );
      }
    }
  }

  /** Writes each key into its Secret, owned by `owner`, which must exist (uid). */
  async write(owner: KeyOwner, keys: Record<string, string>): Promise<void> {
    const { name, namespace, uid } = owner.metadata;
    for (const [model, value] of Object.entries(keys)) {
      const secret = providerKeySecretName(name, model);
      await kubeCall(() =>
        this.#objects.patch(
          {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
              name: secret,
              namespace,
              labels: { 'app.kubernetes.io/managed-by': 'backstage', 'ai.cndev.nl/provider-key-for': name },
              annotations: { 'ai.cndev.nl/model': model },
              ...(uid
                ? { ownerReferences: [{ apiVersion: owner.apiVersion, kind: owner.kind, name, uid }] }
                : {}),
            },
            type: 'Opaque',
            data: { [PROVIDER_KEY_FIELD]: Buffer.from(value, 'utf8').toString('base64') },
          } as any,
          undefined,
          undefined,
          FIELD_MANAGER,
          true,
          PatchStrategy.ServerSideApply,
        ),
      );
      // Never the key itself.
      this.#logger.info(`Wrote provider key Secret ${namespace}/${secret} for model ${model} of ${owner.kind} ${name}`);
    }
  }
}

export const providerKeyServiceRef = createServiceRef<ProviderKeyService>({
  id: 'basis.providerkeys',
  defaultFactory: async service =>
    createServiceFactory({
      service,
      deps: { logger: coreServices.logger, k8s: basisKubernetesServiceRef },
      factory: ({ logger, k8s }) =>
        new ProviderKeyService({
          objects: KubernetesObjectApi.makeApiClient(k8s.kubeConfig),
          logger,
        }),
    }),
});
