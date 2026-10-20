# CNPG promotion leaves the new primary on its old config (workaround)

Status: workaround in the composition function (`function-basis`), upstream fix pending
Affects: CloudNativePG 1.30.1 (also present on upstream `main` as of 2026-10-13),
distributed PostgresClusters (replica clusters switched with a promotion token)

## Symptom

After every switchover/failover between sites, the newly promoted CNPG Cluster
never becomes healthy until someone restarts instances by hand:

- the promoted `Cluster` stays in a non-healthy phase, e.g. `Promoting to primary
  cluster`, `Waiting for the instances to become active`, or (after an operator
  hiccup) `Cluster cannot proceed to reconciliation due to an error while
  interacting with plugins`
- `Ready=False`, `ContinuousArchiving=False: switchover in progress, refusing archiving`
- the XR reports `Waiting for CNPG Cluster <name> in <site>`
- replicas log every second:
  `Refusing to archive WAL when there is a switchover in progress` /
  `failed to run wal-archive command`
- replicas log `parameter "archive_mode" cannot be changed without restarting the server`
- the operator logs nothing at info level, while reconciling the cluster ~1x/second
  (visible as the barman-cloud plugin's `Pre hook reconciliation completed`)

`kubectl cnpg status <name> -o json` shows the cause:

| pod | role | loadedConfigurationHash | pendingRestart |
|---|---|---|---|
| multireg-2 | new primary | `0d5706ac…` (replica-cluster config) | false |
| multireg-1 / -3 | replicas | `217022b0…` (primary-cluster config) | true |

## Root cause

Instance manager, `internal/management/controller/instance_controller.go`
(`InstanceReconciler.Reconcile`):

1. The composition function sets `replica.primary = self` + `promotionToken` on the
   designated primary's site (`place()` in
   `api/function/postgrescluster/topology.go`). The instance manager writes the new
   `postgresql.conf` (replica cluster → primary cluster, e.g.
   `archive_mode: always → on`). `refreshConfigurationFiles` returns
   `reloadNeeded = true` -- a **local variable** of this pass.
2. Same pass, `reconcilePrimary` → `verifyPromotionToken` fails: the WAL up to the
   token's LSN (written at demotion, seconds earlier) is not replayed yet. The pass
   returns early (`Waiting for promotion token to be verified`, requeue 10s)
   **before** the `if reloadNeeded && !restarted { Reload() }` block.
3. Next passes: the file on disk is already current, `reloadNeeded = false`; the
   promotion succeeds, `lastPromotionToken` is recorded, but no reload ever happens.
   Log evidence: `Installed configuration file` is never followed by
   `reloading the instance` (compare with the demotion, where it is).
4. The replicas did reload, so the instances report different
   `loadedConfigurationHash` values. `ClusterReconciler.reconcilePods` waits for a
   uniform configuration (`Waiting for all Pods to have the same PostgreSQL
   configuration`, debug level only) **before** `handleRollingUpdate`, so the
   pending restarts (replicas in place, primary via switchover) are never rolled out.

The demotion side is not affected.

Note: `kubectl cnpg reload` does not help -- it only sets the `cnpg.io/reloadedAt`
annotation to trigger a reconcile; it does not call `pg_reload_conf()`.

## Workaround (this repo)

The composition function (Go, `api/function/postgrescluster/`) owns all
promotion/demotion logic that used to live in the Go template of
`api/apis/postgrescluster/composition.yaml`:

| What | Where |
|---|---|
| target / previous primary site (`primarySite`, `status.primaryLocation`) | `compose.go` (`compose`) |
| switchover/failover handshake, demotion-token check, member roles and `replica` settings | `topology.go` (`place`) |
| draining (geoReplication off while the primary is in the recovery site) | `compose.go` (`compose`) |
| `status.primaryLocation` / `primarySite` / `promotionToken`, waiting messages | `status.go` |
| this workaround | `member.go` (`composition.member`) |

`member.go`, CNPG Cluster section of `composition.member`: for distributed
topologies, once the member's observed Cluster has `status.lastPromotionToken`,
add a placeholder GUC

```yaml
postgresql:
  parameters:
    basis.last_promotion: <first 16 hex chars of sha256(lastPromotionToken)>
```

`lastPromotionToken` is only set after the token was verified and the instance
promoted, so the parameter changes exactly once per promotion, at a point where
the instance manager no longer returns early. Every instance rewrites and reloads
its config, hashes become uniform, and CNPG's normal rolling update restarts the
replicas and switches the primary over (`primaryUpdateMethod: switchover`) by itself.

- CNPG's webhook accepts namespaced GUCs (`prefix.name`); verified with a
  server-side dry-run.
- Changing the parameter is reload-only; on a member whose config is already
  uniform it causes no restart.
- First rollout of this change: every member that was ever promoted gets the
  parameter once (one harmless reload).
- Expected after a promotion: one config reload, in-place restarts of the
  replicas, then one automatic switchover of the new primary (short write
  interruption) to apply `archive_mode`.

Tests:

- unit (`make unit`): `TestPromotionReloadMarker` in
  `api/function/postgrescluster/compose_test.go` checks the parameter value on a
  promoted member and its absence on a never-promoted one; `TestPlace` in
  `topology_test.go` covers the switchover/failover handshake itself.
- render (`make test`): `tests/render/postgrescluster/observed/switchover.yaml`
  gives the recovery member a `lastPromotionToken` from an earlier promotion;
  `tests/render/rendertest` checks the parameter value and that only that member
  carries it.

## Manual recovery (clusters without the workaround)

Reload the config on the new primary; CNPG then rolls out the restarts itself:

```bash
kubectl --context <site> -n <ns> exec <new-primary-pod> -c postgres -- \
  psql -c 'select pg_reload_conf()'
```

Alternative with a brief outage instead of a switchover:
`kubectl cnpg restart <cluster> <new-primary-pod>`.

## Upstream fix (to report)

Any of:

- reload before returning in the `Waiting for promotion token to be verified`
  branch, or
- decide on a reload by comparing the on-disk config hash with
  `current_setting('cnpg.config_sha256')` instead of a per-pass flag, or
- persist "reload pending" across passes.

Remove the workaround (the `basis.last_promotion` block in `member.go`,
`TestPromotionReloadMarker`, and the render fixture/assertion) once the
operator version deployed contains the fix.

## Related, separate observation

On 2026-10-13 08:39 the `protected` API server was unreachable for ~30s; the
barman-cloud plugin exited with `leader election lost` and one operator pod
restarted. The operator then reported the plugin `connection refused` error,
which masked the stuck promotion above. Worth tracking separately.
