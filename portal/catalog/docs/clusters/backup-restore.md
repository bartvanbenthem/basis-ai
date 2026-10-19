# Backups and restore

## Backups

```yaml
spec:
  backup:
    enabled: true
    schedule: "0 0 2 * * *"     # base backup daily at 02:00 (six fields, seconds first)
    retentionPolicy: 30d
```

- The WAL is archived continuously, so you can restore to any moment within the retention, not only
  to a base backup.
- Without `backup.destinationPath`, backups go to the **Project's backup bucket**, with keys of its
  own for each location. To use a store of your own, set `destinationPath` (`s3://bucket/path`) and
  `s3Credentials` (a Secret with `ACCESS_KEY_ID` / `ACCESS_SECRET_KEY`).
- `status.backup` shows the last successful backup and the recoverable window. The cluster's
  **Backups** tab lists the backups.
- The Project's bucket is kept when the Project is deleted, and so are the backups of deleted
  clusters: the Project's inventory (`status.backup.servers`) still lists them.

## Restore

A restore always creates a **new** cluster from a backup folder; the source is only read.

In the portal: **Restore to a new cluster** on a cluster's **Backups** tab, or on the project page for
the folder of a deleted cluster. With kubectl:

```yaml
apiVersion: cnpg.cndev.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: orders-db-restored
  namespace: team-payments
spec:
  postgresVersion: 17                  # the source's major version
  database: {name: app, owner: app}    # the source's application database
  backup: {enabled: true}              # its own backups, in a folder of its own
  restore:
    source:
      serverName: orders-db            # the source's status.backup.serverName
    targetTime: "2026-10-08T09:30:00Z" # leave out for the latest state
```

- `targetTime` must lie in the source's recoverable window; leave it out to restore everything that was
  archived.
- The PostgreSQL major version and the application database must match the source.
- The restored cluster archives to a folder of its own, never into the source's.
- `restore` can only be set when the cluster is created.
- Until the first instance is up, `status.message` says `Restoring <name> from backup folder ...`.
