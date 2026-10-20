# Upgrades

| What | Effect on running databases | How |
|---|---|---|
| function-basis | Only where the new version composes differently | Publish, then roll out the package |
| An XRD or Composition | New fields, rules or defaults | `api/install/install.sh` |
| CloudNativePG operator | Operator restarts; instances get the new instance manager (rolling) | `operator/update-charts.sh`, then `operator/install.sh` per location |
| Image catalog | PostgreSQL **minor** version on every cluster (rolling, switchover of the primary) | `operator/update-charts.sh`, then `operator/install.sh` per location |
| PostgreSQL major | A major upgrade of that cluster | `postgresVersion` on the cluster, forward only |
| Portal | None | New image, `kubectl apply -k portal/deploy/` |

## function-basis

The Composition only names the function (`functionRef: function-basis`), so a new version
changes how every PostgresCluster is composed without touching the Composition.

```sh
cd api
make test                                     # unit + render tests: fail on any unexpected change
make function-push FUNCTION_VERSION=v0.1.2    # image → package → ghcr.io
```

Set the tag in `api/install/function-basis.yaml` and the Makefile's `FUNCTION_VERSION`, commit,
then on every control plane:

```sh
kubectl apply -f api/install/function-basis.yaml
kubectl get function function-basis -w            # INSTALLED and HEALTHY True
kubectl get postgrescluster -A                        # SYNCED and READY stay True
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
