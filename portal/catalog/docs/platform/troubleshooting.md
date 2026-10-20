# Troubleshooting

Start with the object's own report: `kubectl describe postgrescluster <name> -n <project>` shows
`status.message` and the conditions (`Ready`, `Synced`, `PostgresReady`). The cluster page in the
portal shows the same, plus events and pod logs from the location.

## A cluster doesn't become ready

| `status.message` or symptom | Cause | Fix |
|---|---|---|
| `Namespace ... is not a Project with a protected location` | The namespace isn't a Project, or its Project has no protected location | Create it in a Project's namespace |
| `size ... is not in the postgres-sizes catalog` | The size was removed or renamed | Pick a size from the catalog; a running cluster keeps what it has |
| `backup uses the backup bucket of Project ..., which isn't ready` | COSI hasn't provisioned the bucket yet | Check the Project's `status.backup` and the COSI driver |
| `geoReplication is enabled, but Project ... has no recovery location` | The Project has no recovery site | Add `spec.locations.recovery` to the Project |
| `Waiting for CNPG Cluster ...` for long | Pods don't start in the location | The portal's events and logs, or `kubectl get pods` in the location |
| `extensions ... are mounted from images, which needs postgresVersion 18` | An image extension on an older PostgreSQL | Use PostgreSQL 18, or drop the extension |
| A pod fails to mount an extension image | The location doesn't support image volumes | The location's **Image volumes** health check |
| `Synced=False`, e.g. `... has composed resources but no site` | The function refuses to render a desired state that would tear down a running database (an input went missing) | Restore the input it names (the Project, `status.sites`, the size catalog); `kubectl get function function-basis` |

## Geo replication

| Symptom | Cause | Fix |
|---|---|---|
| `Switching the primary ...: waiting for the demotion token` stays | The old primary can't archive its last WAL | Check its location and the bucket; if the location is gone, switch with `promotion: Failover` |
| New primary stuck in `Promoting to primary cluster` after a switchover | A CloudNativePG bug the platform works around | See the [promotion reload workaround](../operations/cnpg-promotion-reload-bug.md) |
| Replica cluster falls behind | WAL archiving lags, or the recovery location can't reach the bucket | `cnpg_wal_archive_pending_bytes`, Project `status.backup.reachability` |

## Platform

| Symptom | Cause | Fix |
|---|---|---|
| Function `Installed=False`, `UNAUTHORIZED` | The package on ghcr.io is private | Make it public or add a pull secret ([Upgrades](upgrades.md)) |
| Location `CONNECTED=False` | Kubeconfig wrong, expired, or an exec plugin | Update it in the portal (Locations → Edit) |
| Location `READY=False`, connected | CloudNativePG or the Prometheus Operator missing there | `operator/install.sh` and `deps/` in that location |
| XR briefly `Responsive=False (WatchCircuitOpen)` | Crossplane rate-limits the watch on CNPG's frequent status updates | Harmless |
| Grafana shows no data | No `prometheus.remoteWrite` in `project-defaults`, or the ingress isn't reachable from the locations | Check `project-defaults` and the remote-write ingress |
| A Project can't be deleted | Deletion protection, or it still has clusters | Delete its clusters, set `deletionProtection: false` |

## Never

- **Don't delete a Project to fix it**: it deletes every cluster in it, and their volumes.
- **Don't edit what Crossplane composed** in a location (CNPG Clusters, Poolers, ...): the next
  reconcile reverts it. Change the PostgresCluster instead.
- **Don't drop the Object of a running cluster** on the control plane; Crossplane would delete what
  it manages in the location.
