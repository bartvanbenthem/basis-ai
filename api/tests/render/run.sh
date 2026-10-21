#!/usr/bin/env bash
# Offline tests for the compositions -- no Kubernetes cluster.
#
#  1. The function's embedded assets are up to date with src/, and
#     function-basis (../../function) builds into a local image.
#  2. `crossplane render` (that image for every API, XRD defaults
#     applied via --xrd) for every <api>/xr/<case>.yaml, first with nothing
#     observed, then with <api>/observed/<case>.yaml if present.
#     <api>/required/<case>.yaml (else <api>/required/default.yaml), if
#     present, mocks the resources the composition requests (the
#     project-defaults EnvironmentConfig, Locations, the Project), plus
#     <api>'s apis/<api>/sizes.yaml (the postgres-sizes catalog) and
#     extensions.yaml (the postgres-extensions catalog) if it has them.
#  3. `crossplane resource validate` of every rendered object against the
#     real CRD schemas: CNPG + Barman Cloud from ../../../deps/cnpg/charts,
#     Prometheus Operator, grafana-operator, provider-kubernetes, the Valkey
#     operator's ValkeyCluster and
#     Crossplane's ClusterUsage from ../crds. The manifest inside each provider-kubernetes Object (what goes
#     to a remote location) is validated too. Core kinds (Namespace,
#     RoleBinding, ...) have no CRD and are skipped.
#  4. Semantic assertions (rendertest/<api>.go).
#
# Requires the crossplane CLI (v2), helm, Go, and a Docker API and CLI (to build the function)
# (rootless podman works: export DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock).
#
#   RENDER_APIS="project location"   only these APIs
#   RENDER_OUT=<dir>                 keep the rendered output there (<api>-<case>-<state>.yaml)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "${HERE}/../.." && pwd)"
OPERATOR_CHARTS="$(cd "${API_ROOT}/../deps/cnpg/charts" && pwd)"
# Built from ../../function by this script; never pulled.
FUNCTION_IMAGE="${FUNCTION_IMAGE:-localhost/function-basis:render}"
read -r -a APIS <<<"${RENDER_APIS:-postgrescluster project location valkeycache modelgateway genaistack}"

if [[ -z "${DOCKER_HOST:-}" && -S "/run/user/${UID}/podman/podman.sock" ]]; then
  export DOCKER_HOST="unix:///run/user/${UID}/podman/podman.sock"
fi

OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT
if [[ -n "${RENDER_OUT:-}" ]]; then
  mkdir -p "${RENDER_OUT}"
  OUT_KEEP="$(cd "${RENDER_OUT}" && pwd)"
fi

echo "=== build rendertest"
RT="${OUT}/rendertest"
(cd "${API_ROOT}" && go build -o "${RT}" ./tests/render/rendertest)

echo "=== generate --check"
(cd "${API_ROOT}" && go run ./hack/generate --check)

echo "=== build function-basis (${FUNCTION_IMAGE})"
docker build -q -f "${API_ROOT}/function/Dockerfile" -t "${FUNCTION_IMAGE}" "${API_ROOT}" >/dev/null
FUNCTIONS="${OUT}/functions.yaml"
cat >"${FUNCTIONS}" <<EOF
apiVersion: pkg.crossplane.io/v1
kind: Function
metadata:
  name: function-basis
  annotations:
    render.crossplane.io/runtime-docker-pull-policy: Never
spec:
  package: ${FUNCTION_IMAGE}
EOF

echo "=== collecting CRD schemas"
SCHEMAS="${OUT}/schemas"
mkdir -p "${SCHEMAS}"
cp "${HERE}/../crds/"*.yaml "${SCHEMAS}/"
# Every API's, also with RENDER_APIS: a GenAIStack composes the others.
for xrd in "${API_ROOT}"/apis/*/definition.yaml; do
  cp "${xrd}" "${SCHEMAS}/xrd-$(basename "$(dirname "${xrd}")").yaml"
done
helm template cnpg "${OPERATOR_CHARTS}/cloudnative-pg" --show-only templates/crds/crds.yaml > "${SCHEMAS}/cnpg-crds.yaml"
helm template barman "${OPERATOR_CHARTS}/plugin-barman-cloud" > "${OUT}/barman-all.yaml"
"${RT}" crds "${OUT}/barman-all.yaml" "${SCHEMAS}/barman-crds.yaml"

fail=0
for api in "${APIS[@]}"; do
  xrd="${API_ROOT}/apis/${api}/definition.yaml"
  composition="${API_ROOT}/apis/${api}/composition.yaml"
  dir="${HERE}/${api}"
  for xr in "${dir}"/xr/*.yaml; do
    case="$(basename "${xr}" .yaml)"
    mocks=()
    if [[ -f "${dir}/required/${case}.yaml" ]]; then
      mocks=("${dir}/required/${case}.yaml")
    elif [[ -f "${dir}/required/default.yaml" ]]; then
      mocks=("${dir}/required/default.yaml")
    fi
    # The shipped postgres-sizes catalog, as installed.
    [[ -f "${API_ROOT}/apis/${api}/sizes.yaml" ]] && mocks+=("${API_ROOT}/apis/${api}/sizes.yaml")
    # ... and the shipped postgres-extensions catalog.
    [[ -f "${API_ROOT}/apis/${api}/extensions.yaml" ]] && mocks+=("${API_ROOT}/apis/${api}/extensions.yaml")
    required=()
    if [[ ${#mocks[@]} -gt 0 ]]; then
      for f in "${mocks[@]}"; do cat "${f}"; echo "---"; done >"${OUT}/required-${api}-${case}.yaml"
      required=(--required-resources="${OUT}/required-${api}-${case}.yaml")
    fi
    for state in empty observed; do
      args=()
      if [[ "${state}" == "observed" ]]; then
        [[ -f "${dir}/observed/${case}.yaml" ]] || continue
        args=(--observed-resources="${dir}/observed/${case}.yaml")
      fi
      out="${OUT}/${api}-${case}-${state}.yaml"
      echo "=== ${api}/${case} (${state}): render"
      if ! crossplane render "${xr}" "${composition}" "${FUNCTIONS}" --xrd "${xrd}" \
          --include-full-xr --include-function-results "${args[@]}" "${required[@]}" >"${out}" 2>"${out}.err"; then
        echo "FAIL: render errored"; cat "${out}.err"; fail=1; continue
      fi

      echo "=== ${api}/${case} (${state}): validate against CRD schemas"
      # Function Result documents are render output only, and core kinds have
      # no CRD to validate against.
      "${RT}" objects "${out}" "${out}.objects"
      if ! crossplane resource validate "${SCHEMAS}" "${out}.objects" --skip-success-results >"${out}.validate" 2>&1; then
        echo "FAIL: schema validation"; cat "${out}.validate"; fail=1
      fi

      echo "=== ${api}/${case} (${state}): assertions"
      "${RT}" assert "${api}" "${case}" "${state}" "${out}" "${API_ROOT}/src/dashboards/cnpg-cluster.json" || fail=1
      [[ -n "${OUT_KEEP:-}" ]] && cp "${out}" "${OUT_KEEP}/"
    done
  done
done

if [[ "${fail}" -ne 0 ]]; then
  echo; echo "Render tests FAILED"; exit 1
fi
echo; echo "All render tests passed."
