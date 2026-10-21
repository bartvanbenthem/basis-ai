# Geo replication and disaster recovery

With geo replication, a cluster keeps a CloudNativePG **replica cluster** in its Project's
recovery location, ready to take over when the protected location fails.

| Field | Meaning |
|---|---|
| `geoReplication.enabled` | The replica cluster in the recovery location. Needs `backup.enabled`. |
| `geoReplication.instances` | Its instances (default: the cluster's `instances`). |
| `geoReplication.primarySite` | `protected` (default) or `recovery`: where the primary runs. Changing it moves the primary. |
| `geoReplication.promotion` | `Switchover` (default) or `Failover`: how a move is carried out. |

The replica cluster starts from the protected site's base backup and then replays its WAL archive
from the Project's backup bucket. The two locations only need the bucket, no network path to each
other. Its lag follows WAL archiving: `cnpg_wal_archive_pending_bytes` on the dashboard is what a
loss of the primary's location would lose.

## Move the primary

In the portal: the cluster's **Disaster recovery** tab. A GenAI stack's database moves with its
stack instead ([Switching sites](../ai/genai-stacks.md#switching-sites)). With kubectl:

```sh
kubectl -n team-payments patch postgrescluster orders-db --type merge \
  -p '{"spec":{"geoReplication":{"primarySite":"recovery"}}}'
```

- **Switchover** (planned, no data loss): the current primary is demoted first and publishes a
  demotion token. The other site is promoted with that token once it has replayed everything the old
  primary wrote. Until then `status.message` says what it waits for. The old primary follows the
  new one as a replica.
- **Failover** (the primary's location is down): set `promotion: Failover` with the move. The other
  site is promoted right away; transactions that weren't archived yet are lost. When the old location
  comes back, it follows the new primary, or has to be recreated if its history diverged.

`status.primaryLocation` and `status.primarySite` show where the primary runs; `status.locations[]`
shows each site's role and health. Move it back with `primarySite: protected`.

## Turn it off

Turning `geoReplication` off removes the replica cluster. If the primary runs in the recovery site at
that moment, the platform first switches it back to the protected site, then removes the replica.

## Good to know

- Applications connect to each site's own services; nothing routes between sites. After a switchover,
  connect to the other location.
- The `<name>-app` Secret in the recovery site is generated there. Manage the application role's
  password with `roles[].passwordSecret` to have the same credentials in both sites.
- After a switchover the primary archives to the recovery site's backup folder. To restore to a moment
  before the switchover, restore from the protected site's folder.
