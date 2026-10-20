#!/usr/bin/env bash
# Removes the cloudian-cosi-driver release and its ClusterRoleBinding
# (see install.sh). The COSI CRDs and controller stay, and with them every
# BucketClaim, BucketAccess and Bucket: a driver installed later (any
# namespace) picks them up again. Until then nothing gets granted or revoked.
#
# REMOVE_CRDS=true also deletes the CRDs and the controller, only once no
# Bucket is left (deleting a CRD deletes all its objects).
#
# Optional:
#   NAMESPACE     default cloudian-cosi
#   REMOVE_CRDS   default false
set -euo pipefail
cd "$(dirname "$0")"

NAMESPACE="${NAMESPACE:-cloudian-cosi}"
RELEASE=cloudian-cosi-driver

helm uninstall "${RELEASE}" --namespace "${NAMESPACE}" --ignore-not-found --wait
kubectl delete clusterrolebinding "${RELEASE}-${NAMESPACE}" --ignore-not-found

[ "${REMOVE_CRDS:-false}" = true ] || exit 0
if [ -n "$(kubectl get buckets.objectstorage.k8s.io -o name 2>/dev/null)" ]; then
  echo "Buckets left; delete their BucketClaims (with the driver installed) first:" >&2
  kubectl get bucketclaims.objectstorage.k8s.io -A >&2
  exit 1
fi
kubectl delete -f upstream/cosi-controller.yaml --ignore-not-found
kubectl delete -f upstream/cosi-api.yaml --ignore-not-found
