# Architecture

## Clusters

| | Control plane | Location |
|---|---|---|
| Purpose | APIs, portal, each Project's observability | Runs the databases and caches |
| Runs | Crossplane 2.4 + function-basis + provider-kubernetes, the portal (Backstage), per Project a Prometheus and Grafana, the COSI controller and driver | CloudNativePG 1.30 + Barman Cloud plugin, image catalogs, the Valkey operator (where caches run), per Project a Prometheus |
| Needs | Prometheus Operator, grafana-operator, an ingress controller | cert-manager, Prometheus Operator (kube-prometheus-stack without Prometheus) |
| Databases, caches | none (the admission policies refuse them) | the CNPG Clusters, the ValkeyClusters |

There can be any number of locations. A Project picks a **protected** location (where its databases
run) and optionally a **recovery** location (replica clusters).

## From object to database

```text
 PostgresCluster (XR, in the Project's namespace on the control plane)
   │  Crossplane runs the Composition's pipeline
   ▼
 function-basis (Go)          reads: the XR, its Project, the size and extension catalogs,
   │                                     the observed state of what it composed before
   │  desired state
   ▼
 provider-kubernetes Objects      one per object, next to the XR on the control plane,
   │                              with the ClusterProviderConfig named after the location
   ▼
 Location: CNPG Cluster, ObjectStore, ScheduledBackup, Databases, Poolers,
           PodMonitor, PrometheusRule, copied Secrets
```

- **One API object per cluster.** The XR is the contract; everything in the locations is derived
  from it on every reconcile, so a change to the XR (or a new function version) rolls out by itself.
- **Live state flows back.** Each Object reports the object it manages
  (`status.atProvider.manifest`); the function reads CNPG's status from there and mirrors it in the
  XR's `status` (phase, instances, primary, endpoints, backups, sites).
- **The function refuses to break a running database.** When an input it needs is missing (the
  Project, the bucket, the size), it keeps what runs instead of rendering an empty or default desired
  state. `status.message` says what is missing.
- **One function composes every API.** function-basis (Go) dispatches on the XR's kind: Project
  (namespaces, RBAC, Prometheus, Grafana, bucket), Location (provider config, checks),
  PostgresCluster, ValkeyCache, ModelServer, ModelGateway, MCPServer and GenAIStack. Each is a package with unit tests, and
  every case is rendered and validated against the real CRD schemas in CI (`make -C api test`).
- **A stack owns what it composes.** A GenAIStack composes the building blocks (PostgresCluster,
  ValkeyCache, ModelGateway) as XRs next to it, labelled `ai.cndev.nl/genaistack`; an admission
  policy lets only Crossplane change them. Switching the stack's site goes to its database, and
  the rest follows its `status.primarySite`.

## Data paths

```text
 Protected location            Object store (Project bucket, COSI)          Recovery location
 CNPG primary ── WAL archive ─▶  <cluster>/                ── replays ─▶  CNPG replica cluster
               ── base backups ─▶                                         (its own folder after
                                                                            a switchover)
 Prometheus ── remote write ──▶ control plane: Project Prometheus ◀── remote write ── Prometheus
                                               Grafana (dashboards)
```

- The sites never talk to each other: replication goes through the bucket, so a location only
  needs outbound access to the object store and the control plane's ingress.
- Each location has its own keys for the bucket, so one site's access can be revoked alone.

## Where things are decided

| Concern | Where |
|---|---|
| Schema, defaults, immutable fields | The XRDs (`api/apis/*/definition.yaml`), enforced by the API server |
| Sizes, extensions, Project defaults | EnvironmentConfigs on the control plane: see [Catalogs](catalogs.md) |
| Cross-object rules (size in catalog, sites set, deletion protection) | ValidatingAdmissionPolicies (`api/apis/*/policies.yaml`) |
| What gets composed, switchover/failover | function-basis (`api/function/<api>`, one package per API) |
| Who may do what in the portal | Backstage permissions (`basis.*`) |

## Growing the stack

Every API works this way: `ValkeyCache` composes a ValkeyCluster, a PodMonitor and a
PrometheusRule in the location and a dashboard in the Project's Grafana; `ModelGateway` Agent Router
in each site; `ModelServer` a KServe LLMInferenceService (vLLM, llm-d's scheduler) on the location's
GPUs; `MCPServer` basis-mcp (a Deployment, its config and keys) next to the database it serves.
The planned layers (guardrails, agent traces; see
[Platform scope](../scope.md)) follow the same pattern: a namespaced API object per service in the
Project's namespace on the control plane, composed by Crossplane into the Project's locations, with
its metrics in the Project's Prometheus and Grafana. The control plane stays free of workloads; GPUs
and model servers run in the locations.
