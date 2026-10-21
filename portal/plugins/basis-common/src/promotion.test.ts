import { allowedPromotions, movesPrimary, primaryState, promotionPatch } from './promotion';
import type { PostgresCluster } from './types';

const cluster = (
  geo: Record<string, unknown> | undefined,
  status: PostgresCluster['status'] = {},
): PostgresCluster => ({
  apiVersion: 'postgres.cndev.nl/v1alpha1',
  kind: 'PostgresCluster',
  metadata: { name: 'orders-db', namespace: 'demo' },
  spec: { instances: 3, ...(geo ? { geoReplication: geo } : {}) },
  status,
});

const settled = cluster(
  { enabled: true, primarySite: 'protected', promotion: 'Switchover' },
  {
    primarySite: 'protected',
    locations: [
      { location: 'dc-a', site: 'protected', role: 'primary', ready: true },
      { location: 'dc-b', site: 'recovery', role: 'replica', ready: true },
    ],
  },
);

const waiting = cluster(
  { enabled: true, primarySite: 'recovery', promotion: 'Switchover' },
  {
    primarySite: 'protected',
    locations: [
      { location: 'dc-a', site: 'protected', role: 'primary', ready: false },
      { location: 'dc-b', site: 'recovery', role: 'promoting', ready: true },
    ],
  },
);

describe('promotion', () => {
  it('offers both modes to the other site when the primary is settled', () => {
    expect(primaryState(settled)).toMatchObject({ current: 'protected', switching: false });
    expect(allowedPromotions(settled)).toEqual([
      { site: 'recovery', mode: 'Switchover' },
      { site: 'recovery', mode: 'Failover' },
    ]);
    expect(promotionPatch(settled, { site: 'recovery', mode: 'Switchover' })).toEqual({
      spec: { geoReplication: { primarySite: 'recovery', promotion: 'Switchover' } },
    });
  });

  it('switches back from the recovery site', () => {
    const inRecovery = cluster(
      { enabled: true, primarySite: 'recovery', promotion: 'Failover' },
      { primarySite: 'recovery' },
    );
    expect(promotionPatch(inRecovery, { site: 'protected', mode: 'Switchover' })).toEqual({
      spec: { geoReplication: { primarySite: 'protected', promotion: 'Switchover' } },
    });
  });

  it('only escalates a waiting switchover to a failover to the same site', () => {
    expect(primaryState(waiting)).toMatchObject({ current: 'protected', target: 'recovery', switching: true });
    expect(allowedPromotions(waiting)).toEqual([{ site: 'recovery', mode: 'Failover' }]);
    expect(promotionPatch(waiting, { site: 'protected', mode: 'Switchover' })).toEqual({
      error: expect.stringMatching(/switchover to the recovery site is in progress/),
    });
    const failing = cluster({ enabled: true, primarySite: 'recovery', promotion: 'Failover' }, { primarySite: 'protected' });
    expect(allowedPromotions(failing)).toEqual([]);
  });

  it('refuses without geo replication, to the current site, and while deleting', () => {
    expect(promotionPatch(cluster(undefined), { site: 'recovery', mode: 'Switchover' })).toEqual({
      error: expect.stringMatching(/geo replication/),
    });
    expect(promotionPatch(settled, { site: 'protected', mode: 'Switchover' })).toEqual({
      error: 'The primary already runs in the protected site.',
    });
    const deleting = { ...settled, metadata: { ...settled.metadata, deletionTimestamp: '2026-10-08T12:00:00Z' } };
    expect(allowedPromotions(deleting)).toEqual([]);
  });

  it('tells edits that move the primary from ones that keep it', () => {
    expect(movesPrimary(settled, undefined)).toBe(false);
    expect(movesPrimary(settled, { instances: 2 })).toBe(false);
    expect(movesPrimary(settled, { primarySite: 'protected' })).toBe(false);
    expect(movesPrimary(settled, { primarySite: 'recovery' })).toBe(true);
    expect(movesPrimary(settled, { promotion: 'Failover' })).toBe(true);
    // Turning geo replication off switches back first: allowed.
    expect(movesPrimary(waiting, { enabled: false, primarySite: 'protected' })).toBe(false);
    expect(movesPrimary(waiting, { primarySite: 'protected' })).toBe(true);
  });
});
