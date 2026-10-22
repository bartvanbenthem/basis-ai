/**
 * Create/edit-server form state and its mapping onto a ModelServer spec.
 * Like the other forms: the fields mirror the XRD, which (with the admission
 * policy) has the final say.
 */

import {
  type ModelServer,
  modelUriScheme,
  SERVER_GROUP,
  SERVER_KIND,
  SERVER_VERSION,
} from '@internal/backstage-plugin-basis-common';
import { mergePatch } from './form';

export interface ServerForm {
  name: string;
  namespace: string;
  owner: string;
  /** spec.model.uri: hf://, pvc://, oci:// or s3://. */
  uri: string;
  /** spec.model.name; empty serves it as the server's name. */
  servedName: string;
  /** A Secret in the project with a Hugging Face token (key HF_TOKEN); empty for none. */
  tokenSecret: string;
  replicas: number;
  cpu: string;
  memory: string;
  gpus: number;
  gpuResource: string;
  /** Another vLLM image; empty for KServe's. */
  image: string;
  /** Extra vllm serve flags, one per line. */
  args: string;
  prefixCacheAware: boolean;
  /** spec.scheduling.nodeSelector as key=value, comma-separated. */
  nodeSelector: string;
  /** Taint keys the pods tolerate (operator Exists), comma-separated. */
  tolerations: string;
  recovery: boolean;
  recoveryReplicas: number;
  alerts: boolean;
}

export const defaultServerForm = (): ServerForm => ({
  name: '',
  namespace: '',
  owner: '',
  uri: '',
  servedName: '',
  tokenSecret: '',
  replicas: 1,
  cpu: '4',
  memory: '16Gi',
  gpus: 1,
  gpuResource: 'nvidia.com/gpu',
  image: '',
  args: '',
  prefixCacheAware: true,
  nodeSelector: '',
  tolerations: '',
  recovery: false,
  recoveryReplicas: 1,
  alerts: true,
});

export function fromServer(server: ModelServer): ServerForm {
  const { metadata, spec } = server;
  const d = defaultServerForm();
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    owner: metadata.labels?.['backstage.io/owner'] ?? '',
    uri: spec.model.uri,
    servedName: spec.model.name ?? '',
    tokenSecret: spec.model.tokenSecretRef?.name ?? '',
    replicas: spec.replicas ?? d.replicas,
    cpu: spec.resources?.cpu ?? d.cpu,
    memory: spec.resources?.memory ?? d.memory,
    gpus: spec.resources?.gpus ?? d.gpus,
    gpuResource: spec.resources?.gpuResource ?? d.gpuResource,
    image: spec.image ?? '',
    args: (spec.args ?? []).join('\n'),
    prefixCacheAware: spec.routing?.prefixCacheAware ?? true,
    nodeSelector: Object.entries(spec.scheduling?.nodeSelector ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(', '),
    tolerations: (spec.scheduling?.tolerations ?? [])
      .map(t => t.key)
      .filter(Boolean)
      .join(', '),
    recovery: Boolean(spec.recovery?.enabled),
    recoveryReplicas: spec.recovery?.replicas ?? d.recoveryReplicas,
    alerts: !spec.alerts?.disabled,
  };
}

const NAME = /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const ARG = /^--[a-z0-9][-a-z0-9]*(=.*)?$/;
const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const GPU_RESOURCE = /^[a-z0-9]([-.a-z0-9]*[a-z0-9])?\/[-._a-zA-Z0-9]+$/;

const list = (s: string) =>
  s
    .split(/[,\n]/)
    .map(x => x.trim())
    .filter(Boolean);

/** The vLLM flags, one per line (a comma inside a flag's value stays). */
const argList = (s: string) =>
  s
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);

const nodeSelector = (s: string) => Object.fromEntries(list(s).map(kv => kv.split('=').map(x => x.trim()) as [string, string]));

/** Field-level errors shown inline; mirrors the XRD's rules. */
export function validateServer(f: ServerForm): Partial<Record<keyof ServerForm, string>> {
  const e: Partial<Record<keyof ServerForm, string>> = {};
  if (!NAME.test(f.name)) e.name = 'Lowercase letters, digits and "-", starting with a letter, max 40 characters.';
  if (!f.namespace) e.namespace = 'Pick the project the server belongs to.';
  if (f.owner && !/^[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/.test(f.owner)) e.owner = 'A group name, e.g. team-payments.';
  if (!modelUriScheme(f.uri.trim()) || f.uri.trim().length > 1000) {
    e.uri = 'hf://<org>/<model>, pvc://<claim>/<path>, oci://<image> or s3://<bucket>/<path>.';
  }
  if (f.servedName.length > 200) e.servedName = 'At most 200 characters.';
  if (f.tokenSecret && !K8S_NAME.test(f.tokenSecret)) e.tokenSecret = 'A Secret name in the project, e.g. hf-token.';
  if (!Number.isInteger(f.replicas) || f.replicas < 0 || f.replicas > 20) e.replicas = '0 to 20';
  if (!/^[0-9]+(\.[0-9]+)?m?$/.test(f.cpu)) e.cpu = 'e.g. 4 or 500m';
  if (!/^[0-9]+(Mi|Gi)$/.test(f.memory)) e.memory = 'e.g. 16Gi';
  if (!Number.isInteger(f.gpus) || f.gpus < 0 || f.gpus > 8) e.gpus = '0 to 8';
  if (!GPU_RESOURCE.test(f.gpuResource)) e.gpuResource = 'e.g. nvidia.com/gpu or amd.com/gpu';
  if (f.gpus === 0 && !f.image.trim()) e.image = "Without GPUs, a CPU build of vLLM, e.g. vllm/vllm-openai-cpu:v0.23.0.";
  const badArg = argList(f.args).find(a => !ARG.test(a));
  if (badArg) e.args = `${badArg}: one flag per line, as --flag or --flag=value.`;
  const badSelector = list(f.nodeSelector).find(kv => !/^[^=]+=[^=]*$/.test(kv) || !LABEL_KEY.test(kv.split('=')[0].trim()));
  if (badSelector) e.nodeSelector = `${badSelector}: label=value, comma-separated.`;
  const badTaint = list(f.tolerations).find(k => !LABEL_KEY.test(k));
  if (badTaint) e.tolerations = `${badTaint}: a taint key, e.g. nvidia.com/gpu.`;
  if (!Number.isInteger(f.recoveryReplicas) || f.recoveryReplicas < 0 || f.recoveryReplicas > 20) e.recoveryReplicas = '0 to 20';
  return e;
}

export function toServerSpec(f: ServerForm): Record<string, unknown> {
  const selector = nodeSelector(f.nodeSelector);
  const tolerations = list(f.tolerations).map(key => ({ key, operator: 'Exists' }));
  return {
    model: {
      uri: f.uri.trim(),
      ...(f.servedName.trim() ? { name: f.servedName.trim() } : {}),
      ...(f.tokenSecret ? { tokenSecretRef: { name: f.tokenSecret } } : {}),
    },
    replicas: f.replicas,
    resources: { cpu: f.cpu, memory: f.memory, gpus: f.gpus, gpuResource: f.gpuResource },
    ...(f.image.trim() ? { image: f.image.trim() } : {}),
    ...(argList(f.args).length ? { args: argList(f.args) } : {}),
    routing: { prefixCacheAware: f.prefixCacheAware },
    ...(Object.keys(selector).length || tolerations.length
      ? {
          scheduling: {
            ...(Object.keys(selector).length ? { nodeSelector: selector } : {}),
            ...(tolerations.length ? { tolerations } : {}),
          },
        }
      : {}),
    recovery: { enabled: f.recovery, replicas: f.recoveryReplicas },
    alerts: { disabled: !f.alerts },
  };
}

export function toServerManifest(f: ServerForm) {
  return {
    apiVersion: `${SERVER_GROUP}/${SERVER_VERSION}`,
    kind: SERVER_KIND,
    metadata: {
      name: f.name || '<name>',
      namespace: f.namespace || '<project>',
      ...(f.owner ? { labels: { 'backstage.io/owner': f.owner } } : {}),
    },
    spec: toServerSpec(f),
  };
}

/** What an edit changes in the spec: a merge patch, empty when nothing changed. */
export function toServerEditPatch(original: ServerForm, f: ServerForm): Record<string, unknown> {
  return (mergePatch(toServerSpec(original), toServerSpec(f)) ?? {}) as Record<string, unknown>;
}

/** The name a gateway's model takes for prefix-cache-aware routing. */
export const servedName = (f: ServerForm) => f.servedName.trim() || f.name || '<name>';
