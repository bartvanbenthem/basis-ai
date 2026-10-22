#!/usr/bin/env bash
# Installs Crossplane v2 core, function-basis (every API's composition,
# ../function), provider-kubernetes
# (which places everything in the locations), the RBAC Crossplane needs, and
# the Location, Project, PostgresCluster, ValkeyCache, ModelServer,
# ModelGateway and GenAIStack APIs (XRDs + Compositions +
# admission policies) into the control plane cluster your current kubeconfig
# context points at. Idempotent -- safe to re-run. Register the locations the
# databases run in afterwards with add-location.sh.
#
# The control plane runs no databases, so it doesn't need CloudNativePG.
# It does run each Project's Prometheus (the remote-write receiver) and
# Grafana: install the Prometheus Operator and grafana-operator first
# (../../deps), or switch them off per Project. Every location needs
# ../../deps/cnpg/install.sh and the Prometheus Operator, the Valkey
# operator where ValkeyCaches run, and KServe where ModelServers run
# (../../deps/README.md).
#
#   FUNCTION_MANIFEST=<file>        install function-basis from this
#                                   manifest instead of function-basis.yaml
#   CROSSPLANE_HELM_ARGS="--set ..." extra arguments for Crossplane's chart
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="${SCRIPT_DIR}/../apis"
CROSSPLANE_NAMESPACE="${CROSSPLANE_NAMESPACE:-crossplane-system}"
CROSSPLANE_VERSION="${CROSSPLANE_VERSION:-2.4.2}"
SKIP_CROSSPLANE="${SKIP_CROSSPLANE:-false}"
FUNCTION_MANIFEST="${FUNCTION_MANIFEST:-${SCRIPT_DIR}/function-basis.yaml}"
read -r -a CROSSPLANE_HELM_ARGS <<<"${CROSSPLANE_HELM_ARGS:-}"

if [[ "${SKIP_CROSSPLANE}" != "true" ]]; then
  echo "==> Crossplane ${CROSSPLANE_VERSION} (helm) in ${CROSSPLANE_NAMESPACE}"
  helm repo add crossplane-stable https://charts.crossplane.io/stable >/dev/null 2>&1 || true
  helm repo update crossplane-stable >/dev/null
  helm upgrade --install crossplane crossplane-stable/crossplane \
    --version "${CROSSPLANE_VERSION}" \
    --namespace "${CROSSPLANE_NAMESPACE}" --create-namespace \
    "${CROSSPLANE_HELM_ARGS[@]}" \
    --wait
fi

echo "==> RBAC for composed objects"
kubectl apply -f "${SCRIPT_DIR}/rbac.yaml"


echo "==> function-basis"
kubectl apply -f "${FUNCTION_MANIFEST}"
kubectl wait function.pkg.crossplane.io/function-basis --for=condition=Healthy --timeout=300s

echo "==> provider-kubernetes (locations)"
kubectl apply -f "${SCRIPT_DIR}/provider-kubernetes.yaml"
kubectl wait provider.pkg.crossplane.io/provider-kubernetes --for=condition=Healthy --timeout=300s

echo "==> Location XRD + Composition"
kubectl apply -f "${API_DIR}/location/definition.yaml"
kubectl wait xrd/locations.platform.cndev.nl --for=condition=Established --timeout=120s
kubectl apply -f "${API_DIR}/location/composition.yaml"

echo "==> PostgresCluster XRD"
kubectl apply -f "${API_DIR}/postgrescluster/definition.yaml"
kubectl wait xrd/postgresclusters.postgres.cndev.nl --for=condition=Established --timeout=120s

echo "==> PostgresCluster Composition"
# Server-side, like earlier installs that embedded the Grafana dashboard
# (too big for client-side apply), so the field manager stays the same.
kubectl apply --server-side --force-conflicts -f "${API_DIR}/postgrescluster/composition.yaml"

echo "==> PostgresCluster sizes and extensions (catalogs, once) + admission policies"
# The catalogs are the platform team's to edit afterwards: never overwrite them.
for catalog in sizes extensions; do
  if ! kubectl get environmentconfig "postgres-${catalog}" >/dev/null 2>&1; then
    kubectl apply -f "${API_DIR}/postgrescluster/${catalog}.yaml"
  fi
done
kubectl apply -f "${API_DIR}/postgrescluster/policies.yaml"

echo "==> Project XRD + Composition"
kubectl apply -f "${API_DIR}/project/definition.yaml"
kubectl wait xrd/projects.platform.cndev.nl --for=condition=Established --timeout=120s
kubectl apply -f "${API_DIR}/project/composition.yaml"

echo "==> Project admission policies (deletion protection, locations)"
sed "s/system:serviceaccount:crossplane-system:crossplane'/system:serviceaccount:${CROSSPLANE_NAMESPACE}:crossplane'/" \
  "${API_DIR}/project/policies.yaml" | kubectl apply -f -

echo "==> Governance: price and model catalogs (once) + policies (model residency, exposure, expiry)"
# Like the size catalog: the platform team's to edit afterwards, never overwritten.
for catalog in project/prices:basis-prices modelgateway/models:basis-models; do
  if ! kubectl get environmentconfig "${catalog#*:}" >/dev/null 2>&1; then
    kubectl apply -f "${API_DIR}/${catalog%%:*}.yaml"
  fi
done
sed "s/system:serviceaccount:crossplane-system:crossplane'/system:serviceaccount:${CROSSPLANE_NAMESPACE}:crossplane'/" \
  "${API_DIR}/project/governance.yaml" | kubectl apply -f -

echo "==> ValkeyCache XRD + Composition + admission policy"
kubectl apply -f "${API_DIR}/valkeycache/definition.yaml"
kubectl wait xrd/valkeycaches.cache.cndev.nl --for=condition=Established --timeout=120s
kubectl apply -f "${API_DIR}/valkeycache/composition.yaml"
kubectl apply -f "${API_DIR}/valkeycache/policies.yaml"

echo "==> ModelServer XRD + Composition + admission policy"
kubectl apply -f "${API_DIR}/modelserver/definition.yaml"
kubectl wait xrd/modelservers.ai.cndev.nl --for=condition=Established --timeout=120s
kubectl apply -f "${API_DIR}/modelserver/composition.yaml"
kubectl apply -f "${API_DIR}/modelserver/policies.yaml"

echo "==> ModelGateway XRD + Composition + admission policy"
kubectl apply -f "${API_DIR}/modelgateway/definition.yaml"
kubectl wait xrd/modelgateways.ai.cndev.nl --for=condition=Established --timeout=120s
kubectl apply -f "${API_DIR}/modelgateway/composition.yaml"
kubectl apply -f "${API_DIR}/modelgateway/policies.yaml"

echo "==> GenAIStack XRD + Composition + admission policies"
kubectl apply -f "${API_DIR}/genaistack/definition.yaml"
kubectl wait xrd/genaistacks.ai.cndev.nl --for=condition=Established --timeout=120s
kubectl apply -f "${API_DIR}/genaistack/composition.yaml"
# The ownership policy lets Crossplane's ServiceAccount through.
sed "s/system:serviceaccount:crossplane-system:crossplane'/system:serviceaccount:${CROSSPLANE_NAMESPACE}:crossplane'/" \
  "${API_DIR}/genaistack/policies.yaml" | kubectl apply -f -

EXAMPLES="$(cd "${SCRIPT_DIR}/.." && pwd)/examples"
echo "==> Done. Try:"
echo "      $(dirname "$0")/add-location.sh <name> <kubeconfig>   # each cluster databases run in"
echo "      kubectl apply -f ${EXAMPLES}/project-defaults.yaml   # edit the ingress hosts first"
echo "      kubectl apply -f ${EXAMPLES}/project.yaml           # its spec.locations name your locations"
echo "      kubectl apply -f ${EXAMPLES}/minimal.yaml"
echo "      kubectl apply -f ${EXAMPLES}/valkeycache.yaml     # needs the Valkey operator in the location"
echo "      kubectl apply -f ${EXAMPLES}/modelserver.yaml     # needs KServe (and GPUs) in the location"
echo "      kubectl apply -f ${EXAMPLES}/modelgateway.yaml    # needs Envoy Gateway + Agent Router in the location"
echo "      kubectl apply -f ${EXAMPLES}/genaistack.yaml      # the same, plus the Valkey operator"
