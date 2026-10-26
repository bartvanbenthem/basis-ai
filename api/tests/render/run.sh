#!/usr/bin/env bash
# Offline tests for the compositions -- no Kubernetes cluster.
#
#  1. The function's embedded assets are up to date with src/, and
#     function-basis (../../function) builds into a local image.
#  2. `crossplane render` (that image for every API, XRD defaults
#     applied via --xrd) for every <api>/xr/<case>.yaml, first with nothing
#     observed, then with the ObjectStores it composed reported by their
#     locations (what a new CNPG Cluster waits for), then with
#     <api>/observed/<case>.yaml if present.
#     <api>/required/<case>.yaml (else <api>/required/default.yaml), if
#     present, mocks the resources the composition requests (the
#     project-defaults EnvironmentConfig, Locations, the Project), plus
#     <api>'s apis/<api>/sizes.yaml (the postgres-sizes catalog) and
#     extensions.yaml (the postgres-extensions catalog) if it has them.
#  3. `crossplane resource validate` of every rendered object against the
#     real CRD schemas: CNPG + Barman Cloud from ../../../deps/cnpg/charts,
#     Prometheus Operator, grafana-operator, provider-kubernetes, the Valkey
#     operator's ValkeyCluster, KServe's LLMInferenceService, Agent Router's
#     and Envoy Gateway's and Crossplane's ClusterUsage from ../crds. The manifest inside each provider-kubernetes Object (what goes
#     to a remote location) is validated too. Core kinds (Namespace,
#     RoleBinding, ...) have no CRD and are skipped.
#  4. Semantic assertions (../../tools/src/bin/rendertest/<api>.rs).
#
# Requires the crossplane CLI (v2), helm, cargo, and a Docker API and CLI (to build the function)
# (rootless podman works: export DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock).
#
#   RENDER_FUNCTION=local            run function-basis as a local process instead of
#                                    a container; FUNCTION_ADDRESS to listen on
#                                    (127.0.0.1:9443)
#   CROSSPLANE_BINARY=<path>         crossplane render's engine as a local Crossplane
#                                    binary instead of its container; with
#                                    RENDER_FUNCTION=local no Docker is needed (go install
#                                    github.com/crossplane/crossplane/v2/cmd/crossplane@<version>)
#   RENDER_APIS="project location"   only these APIs
#   FUNCTION_PREBUILT=true           use FUNCTION_IMAGE as it is (e.g. a published
#                                    function-basis) instead of building it
#   RENDER_OUT=<dir>                 keep the rendered output there (<api>-<case>-<state>.yaml)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "${HERE}/../.." && pwd)"
OPERATOR_CHARTS="$(cd "${API_ROOT}/../deps/cnpg/charts" && pwd)"
# Built from ../../function by this script; never pulled.
FUNCTION_IMAGE="${FUNCTION_IMAGE:-localhost/function-basis:render}"
read -r -a APIS <<<"${RENDER_APIS:-postgrescluster project location valkeycache modelserver modelgateway mcpserver genaistack}"

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
(cd "${API_ROOT}" && cargo build -q -p basis-tools --bin rendertest --bin generate)
RT="${API_ROOT}/target/debug/rendertest"

echo "=== generate --check"
"${API_ROOT}/target/debug/generate" --check

FUNCTIONS="${OUT}/functions.yaml"
if [[ "${RENDER_FUNCTION:-docker}" == "local" ]]; then
  # function-basis as a process on this machine (crossplane render's
  # Development runtime): no container runtime needed.
  echo "=== build and start function-basis (local, ${FUNCTION_ADDRESS:=127.0.0.1:9443})"
  (cd "${API_ROOT}" && cargo build -q --release -p function-basis --bin function-basis)
  "${API_ROOT}/target/release/function-basis" --insecure --address "${FUNCTION_ADDRESS}" >"${OUT}/function.log" 2>&1 &
  FUNCTION_PID=$!
  trap 'kill ${FUNCTION_PID} 2>/dev/null; rm -rf "${OUT}"' EXIT
  cat >"${FUNCTIONS}" <<EOF
apiVersion: pkg.crossplane.io/v1
kind: Function
metadata:
  name: function-basis
  annotations:
    render.crossplane.io/runtime: Development
    render.crossplane.io/runtime-development-target: ${FUNCTION_ADDRESS}
spec:
  package: ${FUNCTION_IMAGE}
EOF
else
  if [[ "${FUNCTION_PREBUILT:-false}" != "true" ]]; then
    echo "=== build function-basis (${FUNCTION_IMAGE})"
    docker build -q -f "${API_ROOT}/function/Dockerfile" -t "${FUNCTION_IMAGE}" "${API_ROOT}" >/dev/null
  fi
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
fi

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
    for state in empty stores observed; do
      args=()
      if [[ "${state}" == "observed" ]]; then
        [[ -f "${dir}/observed/${case}.yaml" ]] || continue
        args=(--observed-resources="${dir}/observed/${case}.yaml")
      elif [[ "${state}" == "stores" ]]; then
        # The empty render's ObjectStores, as their locations report them: a
        # new Cluster waits for them (none composed, no pass).
        "${RT}" stores "${OUT}/${api}-${case}-empty.yaml" "${OUT}/stores-${api}-${case}.yaml"
        [[ -s "${OUT}/stores-${api}-${case}.yaml" ]] || continue
        args=(--observed-resources="${OUT}/stores-${api}-${case}.yaml")
      fi
      out="${OUT}/${api}-${case}-${state}.yaml"
      echo "=== ${api}/${case} (${state}): render"
      engine=()
      [[ -n "${CROSSPLANE_BINARY:-}" ]] && engine=(--crossplane-binary="${CROSSPLANE_BINARY}")
      if ! crossplane render "${xr}" "${composition}" "${FUNCTIONS}" --xrd "${xrd}" "${engine[@]}" \
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
      "${RT}" assert "${api}" "${case}" "${state}" "${out}" "${API_ROOT}/monitoring/dashboards/cnpg-cluster.json" || fail=1
      [[ -n "${OUT_KEEP:-}" ]] && cp "${out}" "${OUT_KEEP}/"
    done
  done
done

if [[ "${fail}" -ne 0 ]]; then
  echo; echo "Render tests FAILED"; exit 1
fi
echo; echo "All render tests passed."
