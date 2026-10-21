import type { PostgresCluster, Site } from './types';

/**
 * Moving the primary of a geo-replicated PostgresCluster to the other site
 * (spec.geoReplication.primarySite/promotion). The composition carries it
 * out: a switchover demotes the primary first and promotes the other site
 * with its demotion token; a failover promotes the other site right away.
 */
export type PromotionMode = 'Switchover' | 'Failover';

export interface PromotionRequest {
  site: Site;
  mode: PromotionMode;
}

/** Where a geo-replicated cluster's primary is, and where it's headed. */
export interface PrimaryState {
  geoReplication: boolean;
  /** Where the primary runs now (status.primarySite). */
  current: Site;
  /** Where the spec wants it (spec.geoReplication.primarySite). */
  target: Site;
  /** How the pending move is carried out (spec.geoReplication.promotion). */
  promotion: PromotionMode;
  /** A move is pending: the target site isn't primary yet. */
  switching: boolean;
}

export const otherSite = (site: Site): Site => (site === 'protected' ? 'recovery' : 'protected');

export function primaryState(cluster: PostgresCluster): PrimaryState {
  const geo = cluster.spec.geoReplication ?? {};
  const target: Site = geo.primarySite === 'recovery' ? 'recovery' : 'protected';
  const current: Site = cluster.status?.primarySite ?? 'protected';
  const promoting = (cluster.status?.locations ?? []).some(l => l.role === 'promoting');
  return {
    geoReplication: Boolean(geo.enabled),
    current,
    target,
    promotion: geo.promotion === 'Failover' ? 'Failover' : 'Switchover',
    switching: target !== current || promoting,
  };
}

/**
 * The moves that make sense now. With the primary settled, both modes go to
 * the other site. While a switchover waits for the old primary's demotion
 * token (which never comes when its site is down), only a failover to the
 * same site is left: it promotes without the token.
 */
export function allowedPromotions(cluster: PostgresCluster): PromotionRequest[] {
  const s = primaryState(cluster);
  if (!s.geoReplication || cluster.metadata.deletionTimestamp) return [];
  if (!s.switching) {
    const site = otherSite(s.current);
    return [
      { site, mode: 'Switchover' },
      { site, mode: 'Failover' },
    ];
  }
  return s.promotion === 'Switchover' ? [{ site: s.target, mode: 'Failover' }] : [];
}

/**
 * The merge patch for `request`, or why it can't be done now. The XRD still
 * has the last word (e.g. geoReplication needs backups).
 */
export function promotionPatch(
  cluster: PostgresCluster,
  request: PromotionRequest,
): { spec: Record<string, unknown> } | { error: string } {
  const s = primaryState(cluster);
  if (!s.geoReplication) {
    return { error: 'The cluster has no replica cluster: turn geo replication on first.' };
  }
  if (cluster.metadata.deletionTimestamp) return { error: 'The cluster is being deleted.' };
  const ok = allowedPromotions(cluster).some(
    a => a.site === request.site && a.mode === request.mode,
  );
  if (!ok) {
    if (!s.switching && request.site === s.current) {
      return { error: `The primary already runs in the ${s.current} site.` };
    }
    return {
      error: `A ${s.promotion.toLowerCase()} to the ${s.target} site is in progress; wait for it to finish${
        s.promotion === 'Switchover' ? ` or fail over to the ${s.target} site` : ''
      }.`,
    };
  }
  return { spec: { geoReplication: { primarySite: request.site, promotion: request.mode } } };
}

/**
 * Whether a spec change made outside the DR actions moves the primary: only
 * turning geo replication off may set primarySite (back to protected; the
 * composition switches over first).
 */
export function movesPrimary(
  cluster: PostgresCluster,
  geo: Record<string, unknown> | undefined,
): boolean {
  if (!geo) return false;
  const before = cluster.spec.geoReplication ?? {};
  const changed = (key: 'primarySite' | 'promotion', dflt: string) =>
    key in geo && (geo[key] ?? dflt) !== (before[key] ?? dflt);
  if (changed('promotion', 'Switchover')) return true;
  if (!changed('primarySite', 'protected')) return false;
  return !(geo.enabled === false && geo.primarySite === 'protected');
}
