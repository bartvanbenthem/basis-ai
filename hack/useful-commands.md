## Useful commands

Set these once; the commands below run against one location and one CNPG cluster. Most of them
work with plain `kubectl`; the ones marked `cnpg` need the plugin (`kubectl krew install cnpg`).
The CNPG `Cluster` is owned by the `PostgresCluster` on the control plane, so changes made directly
to it (other than the annotations below) can be reverted; change the `PostgresCluster` instead.

```sh
K() { kubectl --context {{cluster_context}} -n {{cnpg_namespace}} "$@"; }   # kubectl for this location and namespace
C={{cluster_name}}
PRIMARY=$(K get cluster $C -o jsonpath='{.status.currentPrimary}')
```

### Topology and geo replication

```sh
# check the primary writing side (self vs. primary: which location is the source of truth)
K get cluster $C -o custom-columns=SELF:.spec.replica.self,PRIMARY:.spec.replica.primary,POD:.status.currentPrimary

# the writing side across both locations (a location writes when its replica.self equals replica.primary)
{ echo -e "LOCATION\tSTATE\tPRIMARY_POD"
  for ctx in {{protected_context}} {{recovery_context}}; do
    kubectl --context $ctx -n {{cnpg_namespace}} get cluster $C \
      -o jsonpath="{\"$ctx\"}{\"\t\"}{.spec.replica.self}{\"\t\"}{.spec.replica.primary}{\"\t\"}{.status.currentPrimary}{\"\n\"}" |
    awk -F'\t' -v OFS='\t' '{print $1, ($2==$3 ? "writing" : "replica-of-" $3), $4}'
  done; } | column -t -s $'\t'

# every cluster in the location, with its phase, ready instances and current vs. target primary
# (current != target means a switchover or failover is in progress)
kubectl --context {{cluster_context}} get clusters.postgresql.cnpg.io -A \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,READY:.status.readyInstances,INSTANCES:.status.instances,PRIMARY:.status.currentPrimary,TARGET:.status.targetPrimary

# pods with their role and the node they run on
K get pods -l cnpg.io/cluster=$C -L cnpg.io/instanceRole -o wide

# all status conditions (Ready, ContinuousArchiving, LastBackupSucceeded, ...) with their messages
K get cluster $C -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.message}{"\n"}{end}'

# full picture: replication, WAL archiving, backups, certificates, per instance (cnpg)
kubectl cnpg --context {{cluster_context}} -n {{cnpg_namespace}} status $C --verbose
```

### Replication and lag

```sh
# streaming replicas as seen from the primary, with their lag in bytes and time
K exec $PRIMARY -c postgres -- psql -c "
  select application_name, state, sync_state,
         pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) as replay_lag_bytes,
         replay_lag
  from pg_stat_replication"

# replica cluster in the recovery location: how far behind is the designated primary
# (it replays WAL from the bucket, so the delay follows archive_timeout and write activity)
K exec $PRIMARY -c postgres -- psql -c "
  select pg_is_in_recovery(), pg_last_wal_replay_lsn(),
         now() - pg_last_xact_replay_timestamp() as replay_delay"

# replication slots and how much WAL each one holds back (an inactive slot fills the disk);
# pg_current_wal_lsn() fails during recovery, so a replica cluster measures from its replay position
K exec $PRIMARY -c postgres -- psql -c "
  select slot_name, slot_type, active,
         pg_size_pretty(pg_wal_lsn_diff(
           case when pg_is_in_recovery() then pg_last_wal_replay_lsn() else pg_current_wal_lsn() end,
           restart_lsn)) as retained_wal
  from pg_replication_slots"
```

### Backups and WAL archiving

```sh
# WAL archiving as PostgreSQL sees it: failed_count going up means the bucket is not reachable
K exec $PRIMARY -c postgres -- psql -xc "select * from pg_stat_archiver"

# recovery window per server in the object store: first point you can restore to, last backup
K get objectstores.barmancloud.cnpg.io -o custom-columns=NAME:.metadata.name,WINDOW:.status.serverRecoveryWindow

# backups, oldest first, with their phase and error
K get backups.postgresql.cnpg.io --sort-by=.metadata.creationTimestamp \
  -o custom-columns=NAME:.metadata.name,CLUSTER:.spec.cluster.name,METHOD:.spec.method,PHASE:.status.phase,STARTED:.status.startedAt,STOPPED:.status.stoppedAt,ERROR:.status.error

# scheduled backups, with the last and next run
K get scheduledbackups.postgresql.cnpg.io \
  -o custom-columns=NAME:.metadata.name,SCHEDULE:.spec.schedule,SUSPENDED:.spec.suspend,LAST:.status.lastScheduleTime,NEXT:.status.nextScheduleTime

# on-demand backup through the Barman Cloud plugin
K apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: $C-manual-$(date +%Y%m%d%H%M)
spec:
  cluster:
    name: $C
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
EOF
```

### Operations


```sh
# curl -sSfL https://github.com/cloudnative-pg/cloudnative-pg/raw/main/hack/install-cnpg-plugin.sh | sudo sh -s -- -b /usr/local/bin

# switchover inside the location to a specific replica (cnpg)
kubectl cnpg --context {{cluster_context}} -n {{cnpg_namespace}} promote $C $C-2

# rolling restart of all instances, replicas first and the primary last (cnpg)
kubectl cnpg --context {{cluster_context}} -n {{cnpg_namespace}} restart $C

# fence an instance: PostgreSQL stops but the pod and its PVC stay (for inspection or to stop a
# misbehaving instance); fencing the primary makes the cluster read-only, no failover happens
K annotate cluster $C cnpg.io/fencedInstances='["'$C'-1"]' --overwrite
K annotate cluster $C cnpg.io/fencedInstances-            # unfence

# settings that differ from the default, and the ones that wait for a restart
K exec $PRIMARY -c postgres -- psql -c "
  select name, setting, unit, source, pending_restart
  from pg_settings where source not in ('default', 'override') order by pending_restart desc, name"

# certificate expiry dates (server, replication, client CA)
K get cluster $C -o jsonpath='{.status.certificates.expirations}' | jq

# connect locally to the primary as the app user
K get secret $C-app -o jsonpath='{.data.uri}' | base64 -d; echo   # replace the host with localhost
K port-forward svc/$C-rw 5432:5432
```

### Sessions and locks

```sh
# running queries, longest first
K exec $PRIMARY -c postgres -- psql -c "
  select pid, usename, datname, now() - xact_start as xact_age, state, wait_event_type, wait_event,
         left(query, 80) as query
  from pg_stat_activity
  where state <> 'idle' and pid <> pg_backend_pid()
  order by xact_age desc nulls last"

# who blocks whom
K exec $PRIMARY -c postgres -- psql -c "
  select blocked.pid as blocked_pid, left(blocked.query, 60) as blocked_query,
         blocking.pid as blocking_pid, left(blocking.query, 60) as blocking_query,
         now() - blocking.xact_start as blocking_xact_age
  from pg_stat_activity blocked
  join lateral unnest(pg_blocking_pids(blocked.pid)) as b(pid) on true
  join pg_stat_activity blocking on blocking.pid = b.pid"

# end a session (use pg_cancel_backend first to only cancel its query)
K exec $PRIMARY -c postgres -- psql -c "select pg_terminate_backend(<pid>)"

# PgBouncer: pause all connections (e.g. before a planned switchover) and resume; the Pooler is
# owned by the PostgresCluster too, so resume soon: a resync can reset paused
K patch pooler $C-pooler-rw --type merge -p '{"spec":{"pgbouncer":{"paused":true}}}'
K patch pooler $C-pooler-rw --type merge -p '{"spec":{"pgbouncer":{"paused":false}}}'
```
