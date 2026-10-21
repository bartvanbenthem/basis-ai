#!/usr/bin/env bash
# Removes what install.sh installed. Helm keeps the CRDs (they carry
# helm.sh/resource-policy: keep), so existing Cluster objects and their data
# survive; delete the CRDs by hand only when every Cluster is gone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="${CNPG_NAMESPACE:-cnpg-system}"
RELEASE="${CNPG_RELEASE:-cnpg}"
BARMAN_RELEASE="${BARMAN_RELEASE:-barman-cloud}"

for r in "${BARMAN_RELEASE}" "${RELEASE}"; do
  if helm status "${r}" -n "${NAMESPACE}" >/dev/null 2>&1; then
    echo "==> helm uninstall ${r}"
    helm uninstall "${r}" -n "${NAMESPACE}" --wait
  fi
done

echo "==> ClusterImageCatalog"
kubectl delete -f "${SCRIPT_DIR}/image-catalogs/" --ignore-not-found
