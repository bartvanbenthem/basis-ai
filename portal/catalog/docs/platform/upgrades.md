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
make function-push FUNCTION_VERSION=v0.4.1    # image → package → ghcr.io
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

Editing a size or an extension's image in a [catalog](catalogs.md) rolls the affected clusters out
the same way: instances one by one, the primary last.

## From the cnpg names (function-basis v0.4.0)

v0.4.0 renamed what was named after CloudNativePG but is the platform's: the PostgresCluster API
group (`cnpg.cndev.nl` → `postgres.cndev.nl`), the RBAC (`cnpg-platform:*` → `basis:*`), the
location kubeconfigs' namespace (`cnpg-locations` → `basis-locations`) and the portal plugin
(`/basis`, permissions `basis.*`, config key `basis:`, environment variables `BASIS_KUBE_CONTEXT`, `BASIS_BUCKETS_ENDPOINT` and `BASIS_GRAFANA_URL` instead of `CNPG_*`). It also moved Project and Location to
function-basis and added ModelGateway and the stack ownership policy. On a control plane installed
before, after publishing v0.4.0:

```sh
api/install/migrate-to-basis.sh
```

It needs no PostgresCluster of the old group (a Composition's type can't change, so that API is
removed, not converted); with clusters left it stops and says so. It moves your bindings to the old
roles and the location kubeconfigs, runs `install.sh`, and removes the old RBAC in the locations
once its replacement is there.
