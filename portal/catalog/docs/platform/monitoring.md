# Monitoring

## How metrics flow

Each Project has a Prometheus in every location it uses. It scrapes the Project's clusters (the
`PodMonitor`s the platform creates), evaluates their alerts, labels every series with `location` and
`site` (`protected` or `recovery`), and sends the samples to the Project's Prometheus on the control
plane (remote write, through an ingress that only exposes `/api/v1/write`). The Project's Grafana on
the control plane reads that one, so it shows both sites.

Without `prometheus.remoteWrite` in `project-defaults`, the locations keep their metrics and still
evaluate the alerts, but Grafana sees none.

## Per cluster

| What | Where |
|---|---|
| CloudNativePG exporter (`:9187`) and PgBouncer (`:9127`) | `PodMonitor`s |
| The 19 upstream CNPG alerts, scoped to the cluster | `PrometheusRule` (`monitoring.prometheusRule.excludeRules` drops some) |
| CloudNativePG dashboard | `GrafanaDashboard` in the Project's Grafana, embedded on the cluster's Monitoring tab |
| `cnpg_wal_archive_pending_bytes`, `..._oldest_ready_seconds` | WAL not yet in the object store: what a loss of this location would lose |
| `cnpg_vector_index_*`, `cnpg_create_index_progress_*` | Vector and BM25 index sizes and index builds (Vector & RAG profile) |

The replication-lag alerts skip replica clusters: their lag follows WAL archiving, so watch
`cnpg_wal_archive_*` for the recovery site instead.

## Per cache

| What | Where |
|---|---|
| redis_exporter sidecar, labelled with `cluster` (the cache), `shard` and `node` | `PodMonitor` |
| Nine cache alerts (node down, cluster state, slots, replica link, restarts, rejected writes, connections, eviction, hit ratio) | `PrometheusRule` (`monitoring.prometheusRule.excludeRules` drops some) |
| Valkey cache dashboard | `GrafanaDashboard` in the Project's Grafana, embedded on the cache's Monitoring tab |

See [Valkey caches](../caches/valkey.md#monitoring) for the alerts.

## Platform health

| What | Where |
|---|---|
| Can the control plane reach a location? | `kubectl get locations -o wide` (`CONNECTED`, `READY`), the portal's location health |
| Can a location reach its Project's bucket? | Project `status.backup.reachability` (a check every five minutes from each location), the project page |
| Is a cluster healthy? | `kubectl get postgrescluster -A`: `READY`, and `status.message` / the `PostgresReady` condition |
| Is a cache healthy? | `kubectl get valkeycache -A`: `STATE` and `READY`, and `status.message` |
| Is the function healthy? | `kubectl get function function-basis` |
| The operator | its PodMonitor in `cnpg-system` in every location |
