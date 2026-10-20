#!/usr/bin/env bash
# Installs COSI with the Cloudian HyperStore driver
# (https://github.com/cloudian/cloudian-cosi-driver), all vendored in upstream/:
#   - the COSI CRDs and the cluster-wide controller (namespace cosi-system)
#   - the cloudian-cosi-driver Helm chart (1.0.0) in $NAMESPACE
#   - a ClusterRoleBinding for the driver: the chart binds its ClusterRole to
#     default:default only, the driver runs as $NAMESPACE:default
#   - the BucketAccessClass Projects use (project-defaults backup.cosi.bucketAccessClassName)
# Idempotent: re-run it to change the keys or endpoints.
#
# Run one driver per cluster: each one takes its leader lease in its own
# namespace, so two copies both grant every BucketAccess (and the second grant
# fails on the duplicate IAM user). To move it, ./uninstall.sh the old one
# first (it leaves the CRDs, so buckets and keys survive), then install.
#
# Required (from the environment or ../../env/00-env.sh, kept out of git):
#   COSI_ACCESS_KEY / COSI_SECRET_ACCESS_KEY  HyperStore keys the driver creates
#                                             buckets and IAM users with
#   COSI_S3_ENDPOINT    HyperStore S3 endpoint, e.g. https://s3.example.com
#   COSI_IAM_ENDPOINT   HyperStore IAM endpoint, e.g. https://s3.example.com:16443
# Optional:
#   NAMESPACE           default cloudian-cosi
#   COSI_REGION         default us-east-01
#
# To bump the chart:
#   helm pull oci://quay.io/cloudian/cosi-driver --version <ver> --untar --untardir upstream/charts
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
[ -f ../../env/00-env.sh ] && source ../../env/00-env.sh

NAMESPACE="${NAMESPACE:-cloudian-cosi}"
RELEASE=cloudian-cosi-driver
# Projects' BucketAccesses reference it by name; renaming means re-creating them.
ACCESS_CLASS=cloudian-iam
: "${COSI_ACCESS_KEY:?set COSI_ACCESS_KEY}" "${COSI_SECRET_ACCESS_KEY:?set COSI_SECRET_ACCESS_KEY}"
: "${COSI_S3_ENDPOINT:?set COSI_S3_ENDPOINT}" "${COSI_IAM_ENDPOINT:?set COSI_IAM_ENDPOINT}"

other="$(kubectl get deploy -A -l app.kubernetes.io/name=${RELEASE} \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\n"}{end}' | grep -vx "${NAMESPACE}" || true)"
if [ -n "${other}" ]; then
  echo "${RELEASE} already runs in namespace ${other}; NAMESPACE=${other} ./uninstall.sh first." >&2
  exit 1
fi

kubectl apply --server-side -f upstream/cosi-api.yaml -f upstream/cosi-controller.yaml

# Before the driver starts: it gives up on a forbidden leader lease for minutes.
kubectl create clusterrolebinding "${RELEASE}-${NAMESPACE}" \
  --clusterrole=objectstorage-provisioner-role --serviceaccount="${NAMESPACE}:default" \
  --dry-run=client -o yaml | kubectl apply -f -

# Values on stdin, so the keys stay out of the process list.
helm upgrade --install "${RELEASE}" upstream/charts/cosi-driver \
  --namespace "${NAMESPACE}" --create-namespace --wait --timeout 5m -f - <<EOF
s3:
  s3Endpoint: ${COSI_S3_ENDPOINT}
  iamEndpoint: ${COSI_IAM_ENDPOINT}
  region: ${COSI_REGION:-us-east-01}
  accessKey: "${COSI_ACCESS_KEY}"
  secretAccessKey: "${COSI_SECRET_ACCESS_KEY}"
EOF

kubectl apply -f - <<EOF
apiVersion: objectstorage.k8s.io/v1alpha1
kind: BucketAccessClass
metadata:
  name: ${ACCESS_CLASS}
driverName: ${RELEASE}
authenticationType: IAM
EOF
