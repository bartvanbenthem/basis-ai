# Sourced by the e2e scripts: installs function-tuskpilot built from this
# checkout (api/function) instead of the published package, without a
# registry (Crossplane can't pull packages from a plain-HTTP one).
#
#   local_function_tuskpilot <kind cluster> <kubeconfig> <work dir> <runtime>
#
# 1. Builds the image and loads it into the kind cluster.
# 2. Puts the package metadata into a PersistentVolumeClaim that Crossplane
#    then uses as its package cache (packageCache.pvc), under the id of a
#    digest-pinned reference: with packagePullPolicy: Never Crossplane reads
#    it from there and never contacts the registry.
# 3. Exports FUNCTION_MANIFEST (that Function, plus a DeploymentRuntimeConfig
#    that runs the loaded image) and CROSSPLANE_HELM_ARGS for
#    api/install/install.sh.

local_function_tuskpilot() {
  local cluster="$1" kubeconfig="$2" work="$3" runtime="$4"
  local root image=localhost/function-tuskpilot:e2e
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  local k=(kubectl --kubeconfig "${kubeconfig}")
  local ns="${CROSSPLANE_NAMESPACE:-crossplane-system}"

  echo "==> function-tuskpilot from this checkout (${image})"
  "${runtime}" build -q -f "${root}/api/function/Dockerfile" -t "${image}" "${root}/api" >/dev/null
  "${runtime}" save -o "${work}/function-tuskpilot.tar" "${image}" >/dev/null
  kind load image-archive "${work}/function-tuskpilot.tar" --name "${cluster}" >/dev/null

  local cache="${work}/package-cache" ref
  rm -rf "${cache}" && mkdir -p "${cache}"
  ref="$(cd "${root}/api" && go run ./hack/xpkgcache function/package ghcr.io/bartvanbenthem/function-tuskpilot "${cache}")"

  "${k[@]}" create namespace "${ns}" --dry-run=client -o yaml | "${k[@]}" apply -f - >/dev/null
  "${k[@]}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: crossplane-package-cache
  namespace: ${ns}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 100Mi
---
apiVersion: v1
kind: Pod
metadata:
  name: package-cache-seed
  namespace: ${ns}
spec:
  containers:
    - name: seed
      image: docker.io/library/busybox:1.37
      command: [sleep, "3600"]
      volumeMounts:
        - name: cache
          mountPath: /cache
  volumes:
    - name: cache
      persistentVolumeClaim:
        claimName: crossplane-package-cache
EOF
  "${k[@]}" -n "${ns}" wait pod/package-cache-seed --for=condition=Ready --timeout=180s >/dev/null
  local f
  for f in "${cache}"/*.gz; do
    "${k[@]}" -n "${ns}" cp "${f}" "package-cache-seed:/cache/$(basename "${f}")"
  done
  "${k[@]}" -n "${ns}" delete pod package-cache-seed --wait=false >/dev/null

  FUNCTION_MANIFEST="${work}/function-tuskpilot.yaml"
  cat >"${FUNCTION_MANIFEST}" <<EOF
apiVersion: pkg.crossplane.io/v1beta1
kind: DeploymentRuntimeConfig
metadata:
  name: function-tuskpilot-e2e
spec:
  deploymentTemplate:
    spec:
      selector: {}
      template:
        spec:
          containers:
            - name: package-runtime
              image: ${image}
              imagePullPolicy: Never
---
apiVersion: pkg.crossplane.io/v1
kind: Function
metadata:
  name: function-tuskpilot
spec:
  package: ${ref}
  packagePullPolicy: Never
  runtimeConfigRef:
    name: function-tuskpilot-e2e
EOF
  CROSSPLANE_HELM_ARGS="--set packageCache.pvc=crossplane-package-cache"
  export FUNCTION_MANIFEST CROSSPLANE_HELM_ARGS
}
