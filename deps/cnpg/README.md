# operator: CloudNativePG operator

Installs the operator layer **from this repository only**. Charts are vendored into `charts/`,
so an install is reproducible and reviewable, and does not depend on a remote Helm repo.

| Path | Content |
|---|---|
| `charts/cloudnative-pg/` | `cnpg/cloudnative-pg` **0.29.1** (operator 1.30.1), untouched upstream copy |
| `charts/plugin-barman-cloud/` | `cnpg/plugin-barman-cloud` **0.8.1** (plugin v0.15.1): WAL archiving and base backups to S3/GCS/Azure via CNPG-I |
| `image-catalogs/catalog-standard-trixie.yaml` | ClusterImageCatalog `postgresql-standard-trixie`: digest-pinned PostgreSQL 13–18 images. `PostgresCluster.spec.postgresVersion` resolves through it |
| `values/*.yaml` | Production overrides only (see comments); the full defaults live in each chart's `values.yaml` |

## Install / upgrade

```sh
./install.sh            # helm upgrade --install from ./charts; idempotent
INSTALL_BARMAN=false ./install.sh   # without the backup plugin (no cert-manager needed)
./uninstall.sh          # CRDs are kept (helm.sh/resource-policy: keep), so data survives
```

Environment knobs: `CNPG_NAMESPACE` (default `cnpg-system`), `CNPG_RELEASE` (`cnpg`),
`BARMAN_RELEASE` (`barman-cloud`). The backup plugin must live in the operator's namespace.

Production choices in `values/cloudnative-pg.yaml`:

- 2 operator replicas spread over nodes. The webhooks use `failurePolicy: Fail`, so a single
  evicted pod would otherwise block every Cluster change.
- Requests and limits are set, and cluster-wide watch is on.
- An operator PodMonitor is created. Per-database metrics come from the PodMonitor that
  [`api/`](../api/) creates.

## Bumping versions

```sh
./update-charts.sh                          # latest of both charts + image catalog
CNPG_CHART_VERSION=0.29.1 ./update-charts.sh
./verify.sh                                  # lint + render with production values
git diff --stat .                            # review, then commit
```

An operator minor upgrade also upgrades the CRDs (they're templates in this chart). Read the
[CNPG release notes](https://cloudnative-pg.io/documentation/current/release_notes/) before
bumping. A new image catalog rolls PostgreSQL **minor** versions on every cluster
(rolling update, switchover of the primary).
