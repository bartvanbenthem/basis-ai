# Upgrades

| What | Effect on running databases | How |
|---|---|---|
| function-basis | Only where the new version composes differently | Publish, then roll out the package |
| An XRD or Composition | New fields, rules or defaults | `api/install/install.sh` |
| CloudNativePG operator | Operator restarts; instances get the new instance manager (rolling) | `deps/cnpg/update-charts.sh`, then `deps/cnpg/install.sh` per location |
| Image catalog | PostgreSQL **minor** version on every cluster (rolling, switchover of the primary) | `deps/cnpg/update-charts.sh`, then `deps/cnpg/install.sh` per location |
| PostgreSQL major | A major upgrade of that cluster | `postgresVersion` on the cluster, forward only |
| Portal | None | New image, `kubectl apply -k portal/deploy/` |

## function-basis

The Compositions only name the function (`functionRef: function-basis`), so a new version
changes how every XR of every API is composed without touching the Compositions. A new API needs
the version that composes it: roll the function out before (or with) its XRD.

```sh
cd api
make test                                     # unit + render tests: fail on any unexpected change
make function-push FUNCTION_VERSION=<version>  # image → package → ghcr.io
```

Set the tag in `api/install/function-basis.yaml` and the Makefile's `FUNCTION_VERSION`, commit,
then on every control plane:

```sh
kubectl apply -f api/install/function-basis.yaml
kubectl get function function-basis -w            # INSTALLED and HEALTHY True
kubectl get crossplane -A                         # every XR: SYNCED and READY stay True
```

Every PostgresCluster is composed by the new revision on its next reconcile. A change to a CNPG
Cluster's spec restarts its instances one by one, the primary last. To roll back, apply the previous
tag the same way.

A new package on ghcr.io is private, and Crossplane pulls without credentials: the Function then stays
`Installed=False` with `UNAUTHORIZED`. Make the package public, or give Crossplane a pull secret with an
`ImageConfig` for `ghcr.io/bartvanbenthem/`.

## CloudNativePG and the image catalogs

```sh
cd operator
./update-charts.sh        # latest charts and image catalog (or pin CNPG_CHART_VERSION)
./verify.sh               # lint and render with the production values
git diff --stat .         # review, commit
KUBECONFIG=dc-a.kubeconfig ./install.sh    # per location
```

Read the [CNPG release notes](https://cloudnative-pg.io/documentation/current/release_notes/) first:
a minor operator upgrade also upgrades the CRDs. Upgrade the recovery location first, then the
protected one. After a CNPG upgrade, check the
[promotion reload workaround](../operations/cnpg-promotion-reload-bug.md): it can go once the fix
is in the version you run.

## Catalog changes

Editing an extension's image in the [catalog](catalogs.md) rolls the affected clusters out
the same way: instances one by one, the primary last.

## From sizes to resources

Clusters no longer pick a size from a `postgres-sizes` catalog: `spec.resources` is `{cpu, memory}`,
like the other APIs, and the function tunes PostgreSQL to it. The new XRDs drop `spec.size`, the old
`spec.resources.requests/limits` and a GenAIStack's `retrieval.size`, so what still has them would
fall back to 500m and 1Gi. Pause it around the upgrade:

```sh
# 1. Note what each cluster runs with (a stack's database is <stack>-db)
kubectl get postgresclusters -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,SIZE:.spec.size,CPU:.status.sizing.resources.requests.cpu,MEMORY:.status.sizing.resources.requests.memory
# 2. Pause the sized clusters and stacks; a stack's database only Crossplane may change, so lift
#    that policy meanwhile
kubectl delete validatingadmissionpolicybinding ai.cndev.nl-genaistack-owned
kubectl annotate postgrescluster <name> -n <ns> crossplane.io/paused=true
kubectl annotate genaistack <stack> -n <ns> crossplane.io/paused=true
# 3. The new function and APIs (also removes the size admission policy)
api/install/install.sh
kubectl delete validatingadmissionpolicybinding ai.cndev.nl-genaistack-owned
# 4. Give them their resources (a stack's goes to its database) and resume
kubectl patch postgrescluster <name> -n <ns> --type=merge -p '{"spec":{"resources":{"cpu":"2","memory":"8Gi"}}}'
kubectl patch genaistack <stack> -n <ns> --type=merge -p '{"spec":{"retrieval":{"cpu":"2","memory":"8Gi"}}}'
kubectl annotate genaistack <stack> -n <ns> crossplane.io/paused-
kubectl annotate postgrescluster <name> -n <ns> crossplane.io/paused-   # also each <stack>-db
# 5. The policy back
kubectl apply -f api/apis/genaistack/policies.yaml
```

The tuned settings match the old sizes', except `maintenance_work_mem` for `xs` with the vector
profile (192MB, was 128MB). Delete the `postgres-sizes` EnvironmentConfig once no cluster needs it.
