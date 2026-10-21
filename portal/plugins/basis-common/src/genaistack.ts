/**
 * Shapes of the ai.cndev.nl/v1alpha1 GenAIStack API served by api/
 * (apis/genaistack). The XRD is the source of truth; these types only cover
 * what the portal reads or sends.
 */

import type { GatewayModel } from './modelgateway';
import type { PromotionMode, PromotionRequest } from './promotion';
import type { CacheMode, EvictionPolicy } from './valkey';
import type { Condition, Project, Site } from './types';

export const STACK_GROUP = 'ai.cndev.nl';
export const STACK_VERSION = 'v1alpha1';
export const STACK_PLURAL = 'genaistacks';
export const STACK_KIND = 'GenAIStack';

/** Annotation on catalog Resource entities: "<namespace>/<name>" of their GenAIStack. */
export const STACK_ANNOTATION = 'ai.cndev.nl/genaistack';

/** A model of the stack's own gateway. */
export type StackModel = GatewayModel;

export interface GenAIStackSpec {
  deletionProtection?: boolean;
  recovery?: {
    enabled?: boolean;
    /** Where the stack serves from; changing it switches the stack over. */
    activeSite?: Site;
    promotion?: PromotionMode;
    cacheMemory?: string;
    gatewayReplicas?: number;
  };
  retrieval?: { size?: string; instances?: number; storageSize?: string; backup?: boolean; extensions?: string[] };
  cache?: { enabled?: boolean; mode?: CacheMode; cpu?: string; memory?: string; evictionPolicy?: EvictionPolicy };
  gateway?: {
    enabled?: boolean;
    replicas?: number;
    models?: StackModel[];
    /** A shared ModelGateway instead of one of the stack's own. */
    ref?: string;
    /** The stack's client in the shared gateway; the stack's name by default. */
    client?: string;
  };
}

export interface StackSiteStatus {
  site: Site;
  location: string;
  active: boolean;
  gatewayEndpoint?: string;
  databaseEndpoint?: string;
  cacheEndpoint?: string;
}

export interface GenAIStack {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec: GenAIStackSpec;
  status?: {
    ready?: boolean;
    message?: string;
    activeSite?: Site;
    models?: number;
    connectionSecret?: string;
    components?: { database?: string; cache?: string; recoveryCache?: string; gateway?: string };
    sites?: StackSiteStatus[];
    conditions?: Condition[];
  };
}

/** One row in the portal's stack list. */
export interface GenAIStackSummary {
  name: string;
  namespace: string;
  recovery: boolean;
  activeSite: Site;
  /** Where spec.recovery.activeSite wants it; differs from activeSite while switching. */
  targetSite: Site;
  switching: boolean;
  cache: boolean;
  cacheMode?: CacheMode;
  gateway: boolean;
  /** The ModelGateway the stack uses: its own <name>-gateway, or a shared one. */
  gatewayName?: string;
  sharedGateway: boolean;
  /** The stack's own gateway's models; a shared gateway's are on its page. */
  models: string[];
  ready: boolean;
  synced: boolean;
  deleting: boolean;
  deletionProtection: boolean;
  message?: string;
  owner?: string;
  database: string;
  cacheName?: string;
  recoveryCacheName?: string;
  connectionSecret: string;
  sites: StackSiteStatus[];
  createdAt?: string;
  project?: string;
}

/** The wiring of the active site: the keys of its connection Secret, with values. */
export interface StackConnection {
  site: Site;
  location: string;
  /** DATABASE_URL, VALKEY_URL, OPENAI_BASE_URL, OPENAI_API_KEY, ... */
  values: Record<string, string>;
}

export function summarizeStack(stack: GenAIStack, project?: Project): GenAIStackSummary {
  const { metadata, spec, status } = stack;
  const condition = (type: string) => status?.conditions?.find(c => c.type === type)?.status === 'True';
  const recovery = Boolean(spec.recovery?.enabled);
  const cache = spec.cache?.enabled ?? true;
  const gateway = spec.gateway?.enabled ?? true;
  const activeSite = status?.activeSite ?? 'protected';
  const targetSite: Site = recovery && spec.recovery?.activeSite === 'recovery' ? 'recovery' : 'protected';
  const sites: StackSiteStatus[] =
    status?.sites ??
    (['protected', ...(recovery ? ['recovery'] : [])] as Site[]).map(site => ({
      site,
      location: project?.spec.locations?.[site] ?? '',
      active: site === 'protected',
    }));
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    recovery,
    activeSite,
    targetSite,
    switching: recovery && targetSite !== activeSite,
    cache,
    cacheMode: cache ? spec.cache?.mode ?? 'semantic' : undefined,
    gateway,
    gatewayName: gateway ? status?.components?.gateway ?? spec.gateway?.ref ?? `${metadata.name}-gateway` : undefined,
    sharedGateway: Boolean(spec.gateway?.ref),
    models: (spec.gateway?.models ?? []).map(m => m.name),
    ready: condition('Ready'),
    synced: condition('Synced'),
    deleting: Boolean(metadata.deletionTimestamp),
    deletionProtection: spec.deletionProtection ?? true,
    message: status?.message,
    owner: metadata.labels?.['backstage.io/owner'],
    database: status?.components?.database ?? `${metadata.name}-db`,
    cacheName: cache ? status?.components?.cache ?? `${metadata.name}-cache` : undefined,
    recoveryCacheName: cache && recovery ? status?.components?.recoveryCache ?? `${metadata.name}-cache-dr` : undefined,
    connectionSecret: status?.connectionSecret ?? `${metadata.name}-connection`,
    sites,
    createdAt: metadata.creationTimestamp,
  };
}

/**
 * The moves a stack's switchover can make now, as for its database: with the
 * active site settled, both modes go to the other site; while a switchover
 * waits for the old site (which never answers when it is down), only a
 * failover to the same site is left.
 */
export function allowedStackPromotions(stack: GenAIStack): PromotionRequest[] {
  const s = summarizeStack(stack);
  if (!s.recovery || s.deleting) return [];
  if (!s.switching) {
    const site: Site = s.activeSite === 'protected' ? 'recovery' : 'protected';
    return [
      { site, mode: 'Switchover' },
      { site, mode: 'Failover' },
    ];
  }
  return (stack.spec.recovery?.promotion ?? 'Switchover') === 'Switchover' ? [{ site: s.targetSite, mode: 'Failover' }] : [];
}

/** The merge patch that switches a stack over, or why it can't now. */
export function stackPromotionPatch(
  stack: GenAIStack,
  request: PromotionRequest,
): { spec: Record<string, unknown> } | { error: string } {
  const s = summarizeStack(stack);
  if (!s.recovery) return { error: 'The stack has no standby: turn recovery on first.' };
  if (s.deleting) return { error: 'The stack is being deleted.' };
  if (!allowedStackPromotions(stack).some(a => a.site === request.site && a.mode === request.mode)) {
    if (!s.switching && request.site === s.activeSite) return { error: `The stack already serves from the ${s.activeSite} site.` };
    return { error: `A switch to the ${s.targetSite} site is in progress; wait for it to finish or fail over to it.` };
  }
  return { spec: { recovery: { activeSite: request.site, promotion: request.mode } } };
}
