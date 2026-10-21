#!/usr/bin/env bash
# Removes the PostgresCluster, ValkeyCache, Project and Location APIs from the
# control plane. Refuses while PostgresClusters, ValkeyCaches or Projects exist, because deleting an
# XRD cascade-deletes every object of that kind (and with it the databases in
# the locations). Locations go with their XRD: their ClusterProviderConfigs
# too, but not their kubeconfig Secrets or what the platform installed in
# those clusters.
# Crossplane core stays installed unless UNINSTALL_CROSSPLANE=true.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="${SCRIPT_DIR}/../apis"
CROSSPLANE_NAMESPACE="${CROSSPLANE_NAMESPACE:-crossplane-system}"

if kubectl get crd postgresclusters.postgres.cndev.nl >/dev/null 2>&1; then
  remaining="$(kubectl get postgresclusters.postgres.cndev.nl -A --no-headers 2>/dev/null | wc -l)"
  if [[ "${remaining}" -gt 0 ]]; then
    echo "ERROR: ${remaining} PostgresCluster(s) still exist; delete them first:" >&2
    kubectl get postgresclusters.postgres.cndev.nl -A >&2
    exit 1
  fi
fi

if kubectl get crd genaistacks.ai.cndev.nl >/dev/null 2>&1; then
  remaining="$(kubectl get genaistacks.ai.cndev.nl -A --no-headers 2>/dev/null | wc -l)"
  if [[ "${remaining}" -gt 0 ]]; then
    echo "ERROR: ${remaining} GenAIStack(s) still exist; delete them first:" >&2
    kubectl get genaistacks.ai.cndev.nl -A >&2
    exit 1
  fi
fi

if kubectl get crd modelgateways.ai.cndev.nl >/dev/null 2>&1; then
  remaining="$(kubectl get modelgateways.ai.cndev.nl -A --no-headers 2>/dev/null | wc -l)"
  if [[ "${remaining}" -gt 0 ]]; then
    echo "ERROR: ${remaining} ModelGateway(s) still exist; delete them first:" >&2
    kubectl get modelgateways.ai.cndev.nl -A >&2
    exit 1
  fi
fi

if kubectl get crd valkeycaches.cache.cndev.nl >/dev/null 2>&1; then
  remaining="$(kubectl get valkeycaches.cache.cndev.nl -A --no-headers 2>/dev/null | wc -l)"
  if [[ "${remaining}" -gt 0 ]]; then
    echo "ERROR: ${remaining} ValkeyCache(s) still exist; delete them first:" >&2
    kubectl get valkeycaches.cache.cndev.nl -A >&2
    exit 1
  fi
fi

if kubectl get crd projects.platform.cndev.nl >/dev/null 2>&1; then
  remaining="$(kubectl get projects.platform.cndev.nl --no-headers 2>/dev/null | wc -l)"
  if [[ "${remaining}" -gt 0 ]]; then
    echo "ERROR: ${remaining} Project(s) still exist; delete them first:" >&2
    kubectl get projects.platform.cndev.nl >&2
    exit 1
  fi
fi

kubectl delete -f "${API_DIR}/genaistack/policies.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/genaistack/composition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/genaistack/definition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/modelgateway/policies.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/modelgateway/composition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/modelgateway/definition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/valkeycache/policies.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/valkeycache/composition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/valkeycache/definition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/project/policies.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/project/composition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/project/definition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/postgrescluster/policies.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/postgrescluster/composition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/postgrescluster/definition.yaml" --ignore-not-found
if kubectl get crd locations.platform.cndev.nl >/dev/null 2>&1; then
  kubectl delete locations.platform.cndev.nl --all --wait=true
fi
kubectl delete -f "${API_DIR}/location/composition.yaml" --ignore-not-found
kubectl delete -f "${API_DIR}/location/definition.yaml" --ignore-not-found
# function-go-templating composed Project and Location before function-basis did.
kubectl delete function.pkg.crossplane.io/function-go-templating --ignore-not-found
kubectl delete function.pkg.crossplane.io/function-basis --ignore-not-found
# The postgres-sizes and postgres-extensions catalogs stay, like project-defaults.
# Location kubeconfig Secrets stay (the portal's, or add-location.sh's).
# Leftovers of locations registered before the Location API:
kubectl delete clusterproviderconfigs.kubernetes.m.crossplane.io --all --ignore-not-found 2>/dev/null || true
kubectl delete -f "${SCRIPT_DIR}/provider-kubernetes.yaml" --ignore-not-found
kubectl delete -f "${SCRIPT_DIR}/rbac.yaml" --ignore-not-found
# Installed on the control plane by older versions:
kubectl delete -f "${SCRIPT_DIR}/project-prometheus-role.yaml" --ignore-not-found

if [[ "${UNINSTALL_CROSSPLANE:-false}" == "true" ]]; then
  helm uninstall crossplane -n "${CROSSPLANE_NAMESPACE}"
fi
