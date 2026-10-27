# api/: the BASIS APIs

Crossplane v2 composite resources, composed by one Go composition function, function-basis.

| Level | API | What | Guide |
|---|---|---|---|
| Product | `ai.cndev.nl/v1alpha1 GenAIStack` | Database, caches, model gateway and their wiring per site, one connection Secret | [GenAI stacks](../portal/catalog/docs/ai/genai-stacks.md) |
| Building blocks | `ai.cndev.nl/v1alpha1 ModelGateway` | OpenAI-compatible gateway to hosted and self-hosted models, a key per client | [Model gateways](../portal/catalog/docs/ai/model-gateways.md) |
| | `ai.cndev.nl/v1alpha1 ModelServer` | A self-hosted model: vLLM on KServe with llm-d's routing | [Model servers](../portal/catalog/docs/ai/model-servers.md) |
| | `ai.cndev.nl/v1alpha1 MCPServer` | Retrieval and agent memory as MCP tools over a database | [MCP servers](../portal/catalog/docs/ai/mcp-servers.md) |
| | `postgres.cndev.nl/v1alpha1 PostgresCluster` | A production CloudNativePG cluster in ~10 lines | [Clusters](../portal/catalog/docs/clusters/create.md) |
| | `cache.cndev.nl/v1alpha1 ValkeyCache` | An exact or semantic Valkey cache | [Caches](../portal/catalog/docs/caches/valkey.md) |
| Platform | `platform.cndev.nl/v1alpha1 Project` | A team's namespace with its own Prometheus, Grafana, access, quota and backup bucket | [Projects](../portal/catalog/docs/platform/projects.md) |
| | `platform.cndev.nl/v1alpha1 Location` | A Kubernetes cluster workloads run in | [Locations](../portal/catalog/docs/platform/locations.md) |

The guides (also in the portal under **Docs**) cover every option. The XRDs in
`apis/<api>/definition.yaml` are the schema, with defaults, enums and CEL rules enforced by the API
server, and [`examples/`](examples/) has a manifest for each API.

```yaml
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: orders-db
  namespace: demo
spec:
  resources:       # per instance; PostgreSQL is tuned to it
    cpu: "1"
    memory: 4Gi
  storage:
    size: 20Gi
```

## How it works

- **Control plane and locations.** The APIs run on a control plane: a cluster with Crossplane and
  the portal, but no workloads. Workloads run in locations, other clusters registered as `Location`s.
  A Project has a protected location and optionally a recovery location.
- **Composition.** Each API's Composition is a single pipeline step: function-basis
  ([`function/`](function/), a package per API in `function/<api>`). What runs in a location is
  sent as a provider-kubernetes `Object` through that location's `ClusterProviderConfig`. A
  Project's own Prometheus and Grafana, the dashboards and its backup bucket stay on the control
  plane.
- **Only what it sets.** An object carries only the fields the composition sets, never defaulted or
  empty ones, so operators' defaults stay theirs.
- **Status.** Every XR reports what it runs (endpoints, Secrets, sites, dashboard uid), and a
  condition of its own (`PostgresReady`, `CacheReady`, …) next to Crossplane's `Ready` and `Synced`.
- **Guardrails.** Admission policies in `apis/<api>/policies.yaml`: deletion protection, workloads
  only in their Project's open locations, extensions only from the catalog, and a
  GenAIStack's objects only changed through the stack.

## Install

On the control plane, with the Prometheus Operator and grafana-operator from
[`../deps`](../deps/README.md) installed first:

```sh
install/install.sh                                 # Crossplane, function-basis, provider-kubernetes, RBAC, the APIs and policies, the extensions catalog
install/add-location.sh dc-a dc-a.kubeconfig       # each location; install its operators first (../deps)
kubectl apply -f examples/project-defaults.yaml    # platform-wide Project settings (edit the ingress hosts)
kubectl apply -f examples/project.yaml             # a Project (edit spec.locations)
kubectl apply -f examples/minimal.yaml             # a PostgresCluster in it
kubectl get locations,projects,postgresclusters -A
```

`SKIP_CROSSPLANE=true` reuses an installed Crossplane; `FUNCTION_MANIFEST=<file>` installs another
function package than [`install/function-basis.yaml`](install/function-basis.yaml). Projects are
cluster-scoped: bind `basis:projects:admin` to whoever may create them. Remove everything with
`install/uninstall.sh`.

## Layout

```
apis/<api>/              definition.yaml (XRD), composition.yaml, policies.yaml; postgrescluster/ also extensions.yaml (the catalog)
function/                function-basis: fn.go dispatches on the XR's kind to a package per API (function/<api>)
function/<api>/assets/   what a package embeds: dashboards and alerts GENERATED from monitoring/ (make generate)
monitoring/              dashboards and alert rules, the sources of those assets
install/                 install.sh, uninstall.sh, add-location.sh, RBAC, the function and provider packages
examples/                a manifest for every API
tests/crds/              the operators' CRDs the render tests validate against
tests/render/<api>/      render test cases: xr/, observed/, required/; rendertest/ has the assertions
hack/                    generate (assets, the portal's OpenAPI documents), observe (fixtures), alertrules, xpkgcache (e2e)
```

## Releasing function-basis

The Compositions only name the function (`functionRef: function-basis`), so a new version changes
how every XR is composed. Publish and roll out a new version whenever `function/` changes, and
before or together with a new API's XRD and Composition: a version from before an API answers its
XRs with `function-basis doesn't compose <group>/<version>, Kind=<kind>`. The same goes for a changed
API group or version, which the function matches in `function/fn.go`.

```sh
make test                                       # unit + render tests
make function-push FUNCTION_VERSION=<version>   # image -> _output/*.xpkg -> ghcr.io
# set <version> in install/function-basis.yaml and as FUNCTION_VERSION in the Makefile, commit; then on every control plane:
kubectl apply -f install/function-basis.yaml    # or install/install.sh
kubectl get function function-basis -w          # INSTALLED and HEALTHY on the new package
kubectl get crossplane -A                       # every XR stays SYNCED and READY
```

Versions follow semver: a new API or a composition change is a minor bump, a fix that composes
the same objects a patch. To roll back, apply the previous tag.

Publishing needs Go, the crossplane CLI and Docker or podman, logged in to ghcr.io with a classic
token with `write:packages` (with podman, `podman login --authfile ~/.docker/config.json ghcr.io`,
which is where `crossplane xpkg push` reads credentials). ghcr.io makes a new package private and
Crossplane pulls anonymously: make it public, or give Crossplane a pull secret with an `ImageConfig`
for `ghcr.io/bartvanbenthem/`.

## Develop

```sh
make generate   # after editing monitoring/ (dashboard, alerts) or an XRD (the portal's API reference)
make check      # fails if a generated file is stale
make unit       # go vet + go test
make test       # make unit, then every tests/render/<api> case through the function built from this
                # checkout: crossplane render, every object (and the manifests inside
                # provider-kubernetes Objects) validated against the real CRDs, then the assertions
RENDER_FUNCTION=local CROSSPLANE_BINARY=<crossplane core binary> tests/render/run.sh   # the same without Docker
go run ./hack/observe project full   # regenerate an observed-state fixture after changing a composition
../hack/e2e-kind.sh        # the real thing: a control plane and one location on kind
../hack/e2e-locations.sh   # control plane, protected and recovery location: replication, point-in-time restore, switchover
```

The render tests and the e2e scripts never use the published package: they build function-basis
from the checkout (the e2e scripts load it into kind and seed Crossplane's package cache, see
[`../hack/lib/function-basis.sh`](../hack/lib/function-basis.sh)). `crossplane render` doesn't
resolve namespaced extra resources, so the render tests can't show COSI's credentials Secrets being
unpacked; they check the rest.

A new operator kind the compositions write, or an operator upgrade: put its CRD in `tests/crds/`
(CNPG's come from the vendored charts in `../deps/cnpg/charts`), so the render tests validate
against the version that runs, then `make test`.

## Notes

- Grafana: the default `instanceSelector` is `dashboards.paas.cndev.nl/scope: <namespace>`, which
  matches the GrafanaInstances of the paas platform. Override it with
  `monitoring.grafanaDashboard.instanceSelector`.
- Prometheus: if your Prometheus selects monitors by label (e.g. kube-prometheus-stack's
  `release`), set `monitoring.podMonitorLabels`.
- Crossplane v2 watches composed resources. CNPG updates `Cluster.status` often, so the XR can briefly
  report `Responsive=False (WatchCircuitOpen)`. This is Crossplane rate-limiting itself and is harmless.
- Deleting a PostgresCluster deletes the CNPG Cluster in each site **and its PVCs**. Backups in the object store
  are kept. Protect important databases with RBAC (only `edit` can delete) or a Crossplane `Usage`.
