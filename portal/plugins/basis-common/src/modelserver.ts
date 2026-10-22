/**
 * Shapes of the ai.cndev.nl/v1alpha1 ModelServer API served by api/
 * (apis/modelserver): a self-hosted model, vLLM on KServe with llm-d's
 * prefix-cache-aware routing. The XRD is the source of truth; these types
 * only cover what the portal reads or sends.
 */

import { STACK_OWNER_LABEL } from './modelgateway';
import type { ClusterEvent, Condition, InstancePod, Project, Site } from './types';

export const SERVER_GROUP = 'ai.cndev.nl';
export const SERVER_VERSION = 'v1alpha1';
export const SERVER_PLURAL = 'modelservers';
export const SERVER_KIND = 'ModelServer';

/** Where the weights come from: the URI schemes the XRD allows. */
export const MODEL_URI_SCHEMES = ['hf', 'pvc', 'oci', 's3'] as const;
export type ModelUriScheme = (typeof MODEL_URI_SCHEMES)[number];

export const MODEL_URI_SOURCES: Record<ModelUriScheme, { displayName: string; example: string; description: string }> = {
  hf: {
    displayName: 'Hugging Face',
    example: 'hf://meta-llama/Llama-3.1-8B-Instruct',
    description: 'Downloaded at every pod start; gated and private models need a token.',
  },
  pvc: {
    displayName: 'Volume',
    example: 'pvc://models/llama-3.1-8b',
    description: 'A PersistentVolumeClaim in the project namespace in the location, filled beforehand: fastest to start.',
  },
  oci: {
    displayName: 'OCI image (modelcar)',
    example: 'oci://registry.example.com/models/llama:3.1-8b',
    description: 'An image with the weights, cached by the node like any image.',
  },
  s3: {
    displayName: 'S3',
    example: 's3://models/llama-3.1-8b',
    description: 'Downloaded at every pod start.',
  },
};

export interface ModelServerSpec {
  model: {
    uri: string;
    /** The served name: what clients send as "model". The ModelServer's name when unset. */
    name?: string;
    /** A Hugging Face token (key HF_TOKEN by default) for gated or private hf:// models. */
    tokenSecretRef?: { name: string; key?: string };
  };
  /** vLLM replicas in the protected site; 0 stops the server. */
  replicas?: number;
  resources?: { cpu?: string; memory?: string; gpus?: number; gpuResource?: string };
  /** Another vLLM image; KServe's by default. */
  image?: string;
  /** Extra vllm serve flags, one per item (--flag=value). */
  args?: string[];
  routing?: { prefixCacheAware?: boolean };
  scheduling?: {
    nodeSelector?: Record<string, string>;
    tolerations?: Array<{ key?: string; operator?: 'Exists' | 'Equal'; value?: string; effect?: string }>;
  };
  recovery?: { enabled?: boolean; replicas?: number };
  alerts?: { waitingRequests?: number; kvCacheUsagePercent?: number; timeToFirstTokenSeconds?: number; disabled?: boolean };
}

export interface ServerSiteStatus {
  site: Site;
  location: string;
  replicas?: number;
  ready?: boolean;
  /** What KServe reports when the site isn't ready. */
  message?: string;
}

export interface ModelServer {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec: ModelServerSpec;
  status?: {
    ready?: boolean;
    message?: string;
    /** The served name. */
    model?: string;
    /** OpenAI base URL for apps that call it directly (no key, round robin). */
    endpoint?: string;
    /** The InferencePool a gateway routes to (prefix-cache-aware). */
    inferencePool?: string;
    dashboardUid?: string;
    sites?: ServerSiteStatus[];
    conditions?: Condition[];
  };
}

/** One row in the portal's server list. */
export interface ModelServerSummary {
  name: string;
  namespace: string;
  /** The served name: what a gateway's model is named to use the InferencePool. */
  model: string;
  uri: string;
  replicas: number;
  gpus: number;
  gpuResource: string;
  cpu: string;
  memory: string;
  image?: string;
  prefixCacheAware: boolean;
  recovery: boolean;
  recoveryReplicas: number;
  endpoint: string;
  inferencePool?: string;
  ready: boolean;
  synced: boolean;
  deleting: boolean;
  message?: string;
  owner?: string;
  sites: ServerSiteStatus[];
  dashboardUid?: string;
  createdAt?: string;
  project?: string;
  grafanaUrl?: string;
  /** The GenAIStack that composes this server, if any. */
  stack?: string;
}

/** The detail page: the server, its pods and events in its sites' locations, and the gateways that use it. */
export interface ModelServerDetails {
  summary: ModelServerSummary;
  resource: ModelServer;
  pods: InstancePod[];
  events: ClusterEvent[];
  /** Gateways in the project with a model on this server. */
  gateways: string[];
  /** Set when a location's pods and events couldn't be read. */
  unreachable?: string;
}

/** KServe's Service in front of a server's replicas, port 8000. */
export const serverEndpoint = (name: string, namespace: string) =>
  `http://${name}-kserve-workload-svc.${namespace}.svc:8000/v1`;

/** The pods of a server's vLLM replicas (KServe's labels; the scheduler's pods have another component). */
export const serverLabelSelector = (name: string) =>
  `app.kubernetes.io/name=${name},app.kubernetes.io/part-of=llminferenceservice`;

export function summarizeServer(server: ModelServer, project?: Project): ModelServerSummary {
  const { metadata, spec, status } = server;
  const condition = (type: string) => status?.conditions?.find(c => c.type === type)?.status === 'True';
  const recovery = Boolean(spec.recovery?.enabled);
  const replicas = spec.replicas ?? 1;
  const recoveryReplicas = spec.recovery?.replicas ?? 1;
  const prefixCacheAware = spec.routing?.prefixCacheAware ?? true;
  const sites: ServerSiteStatus[] =
    status?.sites ??
    (['protected', ...(recovery ? ['recovery'] : [])] as Site[]).map(site => ({
      site,
      location: project?.spec.locations?.[site] ?? '',
      replicas: site === 'recovery' ? recoveryReplicas : replicas,
    }));
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    model: status?.model || spec.model.name || metadata.name,
    uri: spec.model.uri,
    replicas,
    gpus: spec.resources?.gpus ?? 1,
    gpuResource: spec.resources?.gpuResource ?? 'nvidia.com/gpu',
    cpu: spec.resources?.cpu ?? '4',
    memory: spec.resources?.memory ?? '16Gi',
    image: spec.image || undefined,
    prefixCacheAware,
    recovery,
    recoveryReplicas,
    endpoint: status?.endpoint || serverEndpoint(metadata.name, metadata.namespace),
    inferencePool: status?.inferencePool || (prefixCacheAware ? `${metadata.name}-inference-pool` : undefined),
    ready: condition('Ready'),
    synced: condition('Synced'),
    deleting: Boolean(metadata.deletionTimestamp),
    message: status?.message,
    owner: metadata.labels?.['backstage.io/owner'],
    sites,
    dashboardUid: status?.dashboardUid || undefined,
    createdAt: metadata.creationTimestamp,
    stack: metadata.labels?.[STACK_OWNER_LABEL] || undefined,
  };
}

/** GPUs the server holds when it runs: per replica, in every site. */
export const serverGPUs = (s: Pick<ModelServerSummary, 'gpus' | 'replicas' | 'recovery' | 'recoveryReplicas'>) =>
  s.gpus * (s.replicas + (s.recovery ? s.recoveryReplicas : 0));

/** The URI scheme of model.uri, if it's one the XRD allows. */
export function modelUriScheme(uri: string): ModelUriScheme | undefined {
  const scheme = /^([a-z0-9]+):\/\//.exec(uri)?.[1];
  return (MODEL_URI_SCHEMES as readonly string[]).includes(scheme ?? '') ? (scheme as ModelUriScheme) : undefined;
}
