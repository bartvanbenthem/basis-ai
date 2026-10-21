#!/usr/bin/env bash
# Installs the CloudNativePG operator, the Barman Cloud backup plugin and the
# PostgreSQL ClusterImageCatalog into the cluster your current kubeconfig
# context points at, from the charts vendored in ./charts -- never from a
# remote Helm repository. Idempotent: re-running performs a helm upgrade.
#
# Prerequisites: helm >= 3.14, kubectl, cert-manager (for the barman plugin),
# Prometheus Operator CRDs (for the operator PodMonitor).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="${CNPG_NAMESPACE:-cnpg-system}"
RELEASE="${CNPG_RELEASE:-cnpg}"
BARMAN_RELEASE="${BARMAN_RELEASE:-barman-cloud}"
INSTALL_BARMAN="${INSTALL_BARMAN:-true}"

echo "==> CloudNativePG operator (chart $(grep '^version:' "${SCRIPT_DIR}/charts/cloudnative-pg/Chart.yaml" | awk '{print $2}'))"
helm upgrade --install "${RELEASE}" "${SCRIPT_DIR}/charts/cloudnative-pg" \
  --namespace "${NAMESPACE}" --create-namespace \
  --values "${SCRIPT_DIR}/values/cloudnative-pg.yaml" \
  --wait --timeout 5m

echo "==> PostgreSQL ClusterImageCatalog"
kubectl apply --server-side -f "${SCRIPT_DIR}/image-catalogs/"

if [[ "${INSTALL_BARMAN}" == "true" ]]; then
  if ! kubectl get crd certificates.cert-manager.io >/dev/null 2>&1; then
    echo "ERROR: cert-manager is required by plugin-barman-cloud (set INSTALL_BARMAN=false to skip)" >&2
    exit 1
  fi
  echo "==> Barman Cloud plugin (chart $(grep '^version:' "${SCRIPT_DIR}/charts/plugin-barman-cloud/Chart.yaml" | awk '{print $2}'))"
  # Must share the operator's namespace: the operator discovers CNPG-I
  # plugins through Services in its own namespace.
  helm upgrade --install "${BARMAN_RELEASE}" "${SCRIPT_DIR}/charts/plugin-barman-cloud" \
    --namespace "${NAMESPACE}" \
    --values "${SCRIPT_DIR}/values/plugin-barman-cloud.yaml" \
    --wait --timeout 5m
fi

echo "==> Done"
kubectl get deploy -n "${NAMESPACE}"
