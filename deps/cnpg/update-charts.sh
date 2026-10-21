#!/usr/bin/env bash
# Refreshes the vendored charts and image catalog to the latest upstream
# release (or the versions passed via env). Review the diff, run
# `./verify.sh`, then commit -- install.sh only ever uses what is in git.
#
#   ./update-charts.sh                                   # latest of everything
#   CNPG_CHART_VERSION=0.29.1 ./update-charts.sh         # pin the operator chart
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CNPG_CHART_VERSION="${CNPG_CHART_VERSION:-}"
BARMAN_CHART_VERSION="${BARMAN_CHART_VERSION:-}"
CATALOG="${CATALOG:-catalog-standard-trixie.yaml}"

helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo update cnpg >/dev/null

pull() {
  local chart="$1" version="$2"
  local tmp
  tmp="$(mktemp -d)"
  helm pull "cnpg/${chart}" ${version:+--version "${version}"} --untar --untardir "${tmp}"
  rm -rf "${SCRIPT_DIR}/charts/${chart}"
  mv "${tmp}/${chart}" "${SCRIPT_DIR}/charts/${chart}"
  rm -rf "${tmp}"
  echo "    ${chart}: $(grep '^version:' "${SCRIPT_DIR}/charts/${chart}/Chart.yaml" | awk '{print $2}') (app $(grep '^appVersion:' "${SCRIPT_DIR}/charts/${chart}/Chart.yaml" | awk '{print $2}'))"
}

echo "==> Vendoring charts into ${SCRIPT_DIR}/charts"
pull cloudnative-pg "${CNPG_CHART_VERSION}"
pull plugin-barman-cloud "${BARMAN_CHART_VERSION}"

echo "==> Vendoring image catalog ${CATALOG}"
curl -fsSL -o "${SCRIPT_DIR}/image-catalogs/${CATALOG}" \
  "https://raw.githubusercontent.com/cloudnative-pg/artifacts/main/image-catalogs/${CATALOG}"

echo "==> Done. Review with: git diff --stat ${SCRIPT_DIR}"
