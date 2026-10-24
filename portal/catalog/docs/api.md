# API reference

The platform's APIs are Kubernetes custom resources on the control plane. The portal, its software
templates, GitOps and `kubectl` all use the same objects, and the API server validates every one of
them against the schema: types, defaults, enums and rules.

| API | Kind | Scope | Reference |
|---|---|---|---|
| `ai.cndev.nl/v1alpha1` | `GenAIStack` (`gstack`) | in a Project's namespace | [GenAIStack API](/catalog/default/api/genaistack/definition) |
| `ai.cndev.nl/v1alpha1` | `ModelGateway` (`mgw`) | in a Project's namespace | [ModelGateway API](/catalog/default/api/modelgateway/definition) |
| `ai.cndev.nl/v1alpha1` | `ModelServer` (`msrv`) | in a Project's namespace | [ModelServer API](/catalog/default/api/modelserver/definition) |
| `ai.cndev.nl/v1alpha1` | `MCPServer` (`mcps`) | in a Project's namespace | [MCPServer API](/catalog/default/api/mcpserver/definition) |
| `postgres.cndev.nl/v1alpha1` | `PostgresCluster` (`pgc`) | in a Project's namespace | [PostgresCluster API](/catalog/default/api/postgrescluster/definition) |
| `cache.cndev.nl/v1alpha1` | `ValkeyCache` (`vcache`) | in a Project's namespace | [ValkeyCache API](/catalog/default/api/valkeycache/definition) |
| `platform.cndev.nl/v1alpha1` | `Project` (`proj`) | cluster | [Project API](/catalog/default/api/project/definition) |
| `platform.cndev.nl/v1alpha1` | `Location` (`loc`) | cluster | [Location API](/catalog/default/api/location/definition) |

Each reference is an OpenAPI document of the CRD Crossplane makes of the API's definition (XRD):
the platform's fields plus Crossplane's own, `spec.crossplane` (which Composition composes it) and
`status.conditions` (`Ready`, `Synced`, and the platform's, such as `PostgresReady`). It is
generated, so it never drifts from what the API server enforces. It shows every field with its type, default and allowed values,
and the rules that apply to it (for example *profile vector needs postgresVersion 18 or later*). The
same reference is under **APIs** in the catalog.

## From the command line

```sh
kubectl explain genaistack.spec                      # the fields, from the same schema
kubectl explain postgrescluster.spec
kubectl explain postgrescluster.spec.geoReplication
kubectl get genaistacks,modelgateways -A            # READY, active site, models
kubectl get postgresclusters -A                      # VERSION, SIZE, PHASE, PRIMARY, LOCATION, READY
kubectl get valkeycaches -A                         # MODE, SHARDS, REPLICAS, STATE, SITE, LOCATION, READY
kubectl apply --dry-run=server -f my-cluster.yaml    # validate, including admission policies
```

## Besides the schema

Admission policies check what a schema can't, against the platform's catalogs:

- `spec.size` must be a size in the `postgres-sizes` catalog.
- Extensions must be in the `postgres-extensions` catalog; one mounted from an image needs
  PostgreSQL 18.
- A cluster needs a namespace whose Project has a protected location, and geo replication needs a
  recovery location.
- A cache needs a namespace whose Project has a location for its `site`, open to new workloads; a
  stack or gateway its protected location, and with recovery its recovery location.
- What a GenAIStack composes (its database, caches and gateway, label `ai.cndev.nl/genaistack`)
  changes only through the stack: changing or deleting it directly is refused.
- A Project with `deletionProtection: true` can't be deleted.

`--dry-run=server` (or **Validate** in the portal) runs all of them without creating anything.
