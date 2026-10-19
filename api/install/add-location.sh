#!/usr/bin/env bash
# Registers another Kubernetes cluster as a location, the same way the portal
# does (Locations > Add location), on the control plane (your current
# context): the kubeconfig as Secret <name> in ${LOCATIONS_NAMESPACE} (label
# platform.cndev.nl/location=true) and a Location <name> pointing at it. The
# Location composition (apis/location) does the rest: the provider-kubernetes
# ClusterProviderConfig, and in the location the ClusterRole every project's
# Prometheus binds to.
#
#   install/add-location.sh <name> <kubeconfig-file> [context]
#
# Settings (displayName, environment, region, schedulable, ...) are on the
# Location: `kubectl edit location <name>`, or the portal.
#
# The location needs operator (CNPG, Barman Cloud plugin, image catalogs)
# and the Prometheus Operator CRDs: run ../../operator/install.sh with
# KUBECONFIG pointing at it first. The kubeconfig is used from inside the
# control plane, so its server must be reachable from there and its
# credentials must not need a local exec plugin (use a token or client
# certificate). Its identity needs to create namespaces, RBAC (incl. binding
# the admin/edit/view roles) and the CNPG/monitoring objects: cluster-admin,
# or an equivalent role.
#
# Re-running updates the kubeconfig. Remove a location with
#   kubectl delete location <name>
#   kubectl -n cnpg-locations delete secret <name>
# The API server refuses the first while a Project uses the location.
set -euo pipefail

LOCATIONS_NAMESPACE="${LOCATIONS_NAMESPACE:-cnpg-locations}"

if [[ $# -lt 2 ]]; then
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 2
fi
NAME="$1"
SOURCE="$2"
CONTEXT="${3:-}"

if ! [[ "${NAME}" =~ ^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$ ]]; then
  echo "ERROR: location names are lowercase letters, digits and \"-\", start with a letter, max 40 characters" >&2
  exit 1
fi
if [[ "${NAME}" == "local" ]]; then
  echo "ERROR: \"local\" is reserved" >&2
  exit 1
fi

KUBECONFIG_FILE="$(mktemp)"
trap 'rm -f "${KUBECONFIG_FILE}"' EXIT
# One context, certificates inlined: what the provider and the portal load.
kubectl config view --kubeconfig "${SOURCE}" ${CONTEXT:+--context "${CONTEXT}"} --minify --flatten >"${KUBECONFIG_FILE}"
if grep -q '^ *exec:' "${KUBECONFIG_FILE}"; then
  echo "ERROR: the kubeconfig authenticates with an exec plugin, which the provider can't run; use a token or client certificate" >&2
  exit 1
fi
LOCATION=(kubectl --kubeconfig "${KUBECONFIG_FILE}")

echo "==> ${NAME}: $("${LOCATION[@]}" config view -o jsonpath='{.clusters[0].cluster.server}')"
"${LOCATION[@]}" version >/dev/null
if ! "${LOCATION[@]}" api-resources --api-group=postgresql.cnpg.io -o name | grep -q '^clusters\.'; then
  echo "WARNING: CloudNativePG is not installed in ${NAME}; run operator/install.sh against it before placing databases there" >&2
fi
# Image volumes (CNPG extension images, PostgreSQL 18+): the API server keeps
# an image volume (ImageVolume feature gate) and every node runs containerd
# >= 2.1 or CRI-O >= 1.31. The portal's location health runs the same check.
if ! "${LOCATION[@]}" -n default create --dry-run=server -o jsonpath='{.spec.volumes[0].image.reference}' -f - >/dev/null 2>&1 <<'YAML'
apiVersion: v1
kind: Pod
metadata: {generateName: tuskpilot-preflight-}
spec:
  securityContext: {runAsNonRoot: true, runAsUser: 65534, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: busybox
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      volumeMounts: [{name: ext, mountPath: /ext}]
  volumes:
    - name: ext
      image: {reference: busybox, pullPolicy: IfNotPresent}
YAML
then
  echo "WARNING: ${NAME}'s API server does not accept image volumes (ImageVolume feature gate); extension images (PostgreSQL 18+) can't be used there" >&2
fi
OLD_RUNTIMES="$("${LOCATION[@]}" get nodes -o jsonpath='{range .items[*]}{.metadata.name}={.status.nodeInfo.containerRuntimeVersion}{"\n"}{end}' \
  | awk -F= '{split($2, r, "://"); split(r[2], v, ".")}
      (r[1]=="containerd" && (v[1]<2 || (v[1]==2 && v[2]<1))) || (r[1]=="cri-o" && (v[1]<1 || (v[1]==1 && v[2]<31))) {print $1}')"
if [[ -n "${OLD_RUNTIMES}" ]]; then
  echo "WARNING: container runtime too old for image volumes (containerd >= 2.1, CRI-O >= 1.31) on: ${OLD_RUNTIMES//$'\n'/, }" >&2
fi

echo "==> control plane: Secret ${LOCATIONS_NAMESPACE}/${NAME} + Location ${NAME}"
kubectl create namespace "${LOCATIONS_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "${LOCATIONS_NAMESPACE}" create secret generic "${NAME}" \
  --from-file=kubeconfig="${KUBECONFIG_FILE}" --dry-run=client -o yaml \
  | kubectl label --local -f - -o yaml platform.cndev.nl/location=true \
  | kubectl apply -f -
# Server-side apply of just the credentials: settings made in the portal or
# with kubectl edit stay.
kubectl apply --server-side --field-manager=add-location -f - <<YAML
apiVersion: platform.cndev.nl/v1alpha1
kind: Location
metadata:
  name: ${NAME}
spec:
  credentials:
    secretRef:
      namespace: ${LOCATIONS_NAMESPACE}
      name: ${NAME}
      key: kubeconfig
YAML
kubectl wait "location.platform.cndev.nl/${NAME}" --for=jsonpath='{.status.connected}'=true --timeout=120s \
  || echo "WARNING: Crossplane hasn't reached ${NAME} yet; see kubectl get location ${NAME} -o wide" >&2

echo "==> Done. Use \"${NAME}\" in a Project's spec.locations, as its protected"
echo "    location (where its databases run) or its recovery location (replica clusters)."
