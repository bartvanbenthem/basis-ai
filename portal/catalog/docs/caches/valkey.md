# Valkey caches

A `ValkeyCache` is the cache layer of an AI service: an **exact** cache for answers you have seen
before (a hash of the normalised prompt plus its context, tool, SQL and search results) or a
**semantic** cache that also finds prompts that mean the same thing, through embeddings. It runs
[Valkey](https://valkey.io/) 9.1, by the [valkey-io operator](https://github.com/valkey-io/valkey-operator),
in one of your Project's locations, with a generated password, metrics, alerts and a Grafana
dashboard, like a [PostgresCluster](../getting-started.md).

A [GenAI stack](../ai/genai-stacks.md) composes caches of its own (`<stack>-cache`); those change
through the stack. This page is about caches on their own, and what every cache shares.

## Create a cache

In the portal: **Building blocks → Valkey caches**, then **Create cache**, or **Create semantic cache** for one with vector search. Pick the
Project, the site and the size. Or with `kubectl`:

```yaml
apiVersion: cache.cndev.nl/v1alpha1
kind: ValkeyCache
metadata:
  name: llm-cache
  namespace: demo            # your Project
spec:
  mode: semantic             # exact (default) | semantic: also loads valkey-search
  shards: 1                  # cluster mode, 1..16
  replicas: 0                # per shard (default 1)
  resources: {cpu: "1", memory: 1Gi}
```

```sh
kubectl apply -f llm-cache.yaml
kubectl get valkeycaches -n demo       # MODE, SHARDS, REPLICAS, STATE, SITE, LOCATION, READY
```

The **Valkey caches** page lists every cache you can see; a cache's page shows its state,
how to connect, memory, pods, conditions and events, and its Grafana dashboard on the
**Monitoring** tab.

## Settings

| Field | Default | What |
|---|---|---|
| `mode` | `exact` | `exact`: key/value with TTLs. `semantic`: also the valkey-search module (FT.CREATE / FT.SEARCH, HNSW/KNN with tag and numeric filters). **Fixed after creation** |
| `site` | `protected` | Which of the Project's locations runs it: `protected` or `recovery` (the Project needs one). Caches don't replicate between sites: for a cache next to workloads in both, create one per site. **Fixed after creation** |
| `shards` | `1` | Primaries the keyspace is spread over (1 to 16). More shards give more memory and write throughput, with a cluster-aware client |
| `replicas` | `1` | Replicas per shard (0 to 5). A replica takes over when its primary fails, so the cache stays warm; with 0 a pod restart empties that shard |
| `resources.cpu`, `resources.memory` | `500m`, `1Gi` | Per Valkey pod; memory (`Mi` or `Gi`) is request and limit |
| `maxMemoryPercent` | `75` | Share of the memory Valkey fills with keys before it evicts (`maxmemory`, 10 to 90). The rest is for replication buffers, fragmentation and, in semantic mode, building indexes |
| `evictionPolicy` | `allkeys-lru` | What goes at `maxmemory`. `allkeys-lru` or `allkeys-lfu` suit a cache; `volatile-*` only evicts keys with a TTL; `noeviction` refuses writes instead |
| `monitoring` | all on | Metrics, alerts and dashboard, see [Monitoring](#monitoring) |

The full schema, with every rule, is in the [API reference](../api.md).

**A cache, not a store.** Valkey keeps everything in memory, with no persistence and no backups. Keep
your primary vector store in PostgreSQL ([Vector & RAG](../clusters/vector-rag.md)) and use a
semantic cache for answers you can afford to lose.

## Connect

The platform generates the password of the `default` user once and keeps it. It's in two Secrets:

| Secret | Where | For |
|---|---|---|
| `<name>-valkey-auth` | the Project's namespace in the location | workloads next to the cache |
| `<name>-valkey` | the Project's namespace on the control plane | the portal, CI, reading it without the location's kubeconfig |

Both have `username`, `password`, `host`, `port` and `uri`
(`valkey://default:<password>@valkey-<name>.<project>.svc:6379`). The user may run every command except
the `@admin` ones.

Valkey runs in **cluster mode**, behind the Service `valkey-<name>` (`status.endpoint`):

- **Cluster-aware clients** (valkey-glide, redis-py's `RedisCluster`, redisvl) work with any number of
  shards and replicas.
- **Clients without cluster support**, such as LiteLLM's `valkey-semantic` cache, need `shards: 1` and
  `replicas: 0`, so the Service always reaches the primary.

LiteLLM with a semantic cache, `VALKEY_PASSWORD` from the Secret's `password`:

```yaml
cache: true
cache_params:
  type: valkey-semantic
  host: valkey-llm-cache.demo.svc
  port: "6379"
  valkey_semantic_cache_embedding_model: <an embedding model in model_list>
  similarity_threshold: 0.9     # start strict; measure hits against wrong answers
```

## Use it safely

The cache sits in front of guardrails and context construction, so a wrong hit hands one user's
answer to another:

- Put the tenant, user or role scope in every key, or as a TAG filter in the KNN query.
- Put the model ID and the system-prompt version in the key.
- Start semantic thresholds strict (about 0.9) and measure hits against wrong answers before you
  loosen them.
- Purge, or shorten TTLs, when the source data changes.

This cache stores answers. It is not the model server's KV or prefix cache (vLLM, LMCache, llm-d).

## Change or delete a cache

**Edit** on the cache's page, or `kubectl apply`, changes shards, replicas, resources, memory and
eviction. A change that restarts pods empties them unless a replica takes over, so with
`replicas: 0` expect a cold cache afterwards. To change `mode` or `site`, create a new cache.

**Delete** removes the cache and its keys in the location, its Secrets and its dashboard.

## Monitoring

As with a PostgresCluster, everything lands in your Project's Prometheus and Grafana:

| What | Where |
|---|---|
| redis_exporter sidecar on every pod, with `cluster` (the cache), `shard` and `node` labels; semantic caches add valkey-search's metrics | `PodMonitor <name>-valkey` (`monitoring.enabled`) |
| Alerts, scoped to the cache | `PrometheusRule <name>-alerts` (`monitoring.prometheusRule`; `excludeRules` drops some) |
| Hit ratio, keys, memory of maxmemory, evictions, commands and latency, clients, cluster and replication health, valkey-search | `GrafanaDashboard` in the Project's Grafana (`monitoring.grafanaDashboard`), on the cache's **Monitoring** tab |

| Alert | Severity | Fires when |
|---|---|---|
| `ValkeyCacheDown` | critical | A node doesn't answer the exporter |
| `ValkeyCacheClusterStateNotOk` | critical | The cluster reports state `fail` |
| `ValkeyCacheSlotsFailing` | warning | Hash slots in FAIL or PFAIL |
| `ValkeyCacheReplicaLinkDown` | warning | A replica lost its primary |
| `ValkeyCacheRestarting` | warning | A node keeps restarting |
| `ValkeyCacheWritesRejected` | warning | Writes are refused at `maxmemory` (`noeviction`, or `volatile-*` with too few keys that have a TTL) |
| `ValkeyCacheTooManyConnections` | warning | Connections near `maxclients` |
| `ValkeyCacheEvicting` | info | Keys are evicted continuously: the cache is too small for its working set |
| `ValkeyCacheLowHitRatio` | info | Few lookups hit: check the keys and the threshold |

Being at `maxmemory` alone is normal for a cache and doesn't alert.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Refused: `namespace ... is not a Project with a protected location` | Not in a Project's namespace, or `site: recovery` in a Project without a recovery location | Create it in a Project; set `spec.locations.recovery` or use `site: protected` |
| Refused: `location ... is closed to new workloads` | The location is `schedulable: false` | Use the other site, or ask a platform admin |
| `STATE` stays empty or `Pending` | The Valkey operator isn't installed in the location | The location's **Valkey operator** health check; see [Install](../platform/install.md) |
| `Degraded` or `Failed` | Pods don't start or the cluster lost a shard | The cache page's pods and events, or `kubectl get pods` in the location |
| `MOVED` errors | A client without cluster support on a cache with several shards | Use a cluster-aware client, or `shards: 1` and `replicas: 0` |
| `NOAUTH` / `WRONGPASS` | No or a wrong password | The `password` from `<name>-valkey-auth` |
| `unknown command 'FT.CREATE'` | An exact cache | Create a cache with `mode: semantic` |
