#!/usr/bin/env bash
# End-to-end test on two throwaway kind clusters: a control plane (Crossplane,
# the APIs, each Project's Grafana and the Prometheus that receives its
# metrics; no CloudNativePG) and one location the databases run in. Installs
# the prerequisites (deps), operator and api as
# documented, creates a Project (namespaces, Prometheus, Grafana) with that
# location as its protected site and a PostgresCluster in it, and checks that
# the database is healthy, its metrics reach the location's Prometheus and,
# by remote write, the project's Prometheus on the control plane, its
# dashboard reaches the project's Grafana, and that the Project deletion
# guardrails hold. hack/e2e-locations.sh covers the recovery site.
#
# Uses its own kubeconfig files (never touches your current context):
#   hack/e2e-kind.sh                 # create clusters, install, test
#   KEEP=true hack/e2e-kind.sh       # leave the clusters running afterwards
#   export KUBECONFIG=$(pwd)/.e2e/cp.kubeconfig   # then poke around
#
# Rootless podman works: KIND_EXPERIMENTAL_PROVIDER=podman hack/e2e-kind.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/function-tuskpilot.sh
source "${ROOT}/hack/lib/function-tuskpilot.sh"
CP="${CONTROL_PLANE_CLUSTER:-cnpg-e2e-cp}"
LOC="${LOCATION_CLUSTER:-cnpg-e2e-loc}"
LOCATION=e2e-loc
WORK="${ROOT}/.e2e"
mkdir -p "${WORK}"
CP_KUBECONFIG="${WORK}/cp.kubeconfig"
LOC_KUBECONFIG="${WORK}/loc.kubeconfig"

CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.2}"
KUBE_PROMETHEUS_STACK_VERSION="${KUBE_PROMETHEUS_STACK_VERSION:-89.2.0}"
GRAFANA_OPERATOR_VERSION="${GRAFANA_OPERATOR_VERSION:-5.25.0}"
HAPROXY_INGRESS_VERSION="${HAPROXY_INGRESS_VERSION:-1.54.0}"

# Two kind clusters run out of inotify instances at the default 128.
if [[ "$(sysctl -n fs.inotify.max_user_instances 2>/dev/null || echo 512)" -lt 512 ]]; then
  echo "ERROR: fs.inotify.max_user_instances is below 512; two kind clusters need more:" >&2
  echo "  sudo sysctl fs.inotify.max_user_instances=512" >&2
  exit 1
fi

RUNTIME=docker
if [[ "${KIND_EXPERIMENTAL_PROVIDER:-}" == "podman" ]] || ! command -v docker >/dev/null; then
  RUNTIME=podman
fi

for c in "${CP}:${CP_KUBECONFIG}" "${LOC}:${LOC_KUBECONFIG}"; do
  name="${c%%:*}" kc="${c#*:}"
  if ! kind get clusters 2>/dev/null | grep -qx "${name}"; then
    echo "==> kind cluster ${name}"
    kind create cluster --name "${name}" --kubeconfig "${kc}" --wait 180s
  fi
  kind export kubeconfig --name "${name}" --kubeconfig "${kc}" >/dev/null
done

cleanup() {
  if [[ "${KEEP:-false}" != "true" ]]; then
    kind delete cluster --name "${CP}" --kubeconfig "${CP_KUBECONFIG}" || true
    kind delete cluster --name "${LOC}" --kubeconfig "${LOC_KUBECONFIG}" || true
  fi
}
trap cleanup EXIT

C=(kubectl --kubeconfig "${CP_KUBECONFIG}")
L=(kubectl --kubeconfig "${LOC_KUBECONFIG}")
node_ip() { "${RUNTIME}" inspect -f '{{ (index .NetworkSettings.Networks "kind").IPAddress }}' "$1-control-plane"; }
CP_IP="$(node_ip "${CP}")"

wait_for() { # <description> <tries> <command...>: retry every 10s
  local what="$1" tries="$2"; shift 2
  for _ in $(seq 1 "${tries}"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 10
  done
  echo "FAIL: ${what}"; return 1
}

kube_prometheus_stack() { # <kubeconfig>: same flags as deps/README.md
  helm upgrade -i prometheus-operator kube-prometheus-stack --kubeconfig "$1" \
    --repo https://prometheus-community.github.io/helm-charts \
    --version "${KUBE_PROMETHEUS_STACK_VERSION}" -n prometheus-operator-system --create-namespace \
    --set prometheus.enabled=false --set alertmanager.enabled=false --set grafana.enabled=false \
    --wait --timeout 10m >/dev/null
}

echo "==> control plane (deps): Prometheus Operator, grafana-operator, HAProxy Ingress"
kube_prometheus_stack "${CP_KUBECONFIG}"
helm upgrade -i grafana-operator grafana-operator --kubeconfig "${CP_KUBECONFIG}" \
  --repo https://grafana.github.io/helm-charts \
  --version "${GRAFANA_OPERATOR_VERSION}" -n grafana-operator-system --create-namespace \
  --wait --timeout 5m >/dev/null
# On the node's port 80, which the location's Prometheus reaches over the
# kind network for remote write.
helm upgrade -i haproxy-ingress kubernetes-ingress --kubeconfig "${CP_KUBECONFIG}" \
  --repo https://haproxytech.github.io/helm-charts \
  --version "${HAPROXY_INGRESS_VERSION}" -n haproxy-ingress --create-namespace \
  --set controller.ingressClassResource.default=true \
  --set controller.kind=DaemonSet --set controller.daemonset.useHostPort=true \
  --wait --timeout 5m >/dev/null

echo "==> location (deps + operator): cert-manager, Prometheus Operator, CloudNativePG"
"${L[@]}" apply --server-side -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml" >/dev/null
kube_prometheus_stack "${LOC_KUBECONFIG}"
"${L[@]}" -n cert-manager wait deploy --all --for=condition=Available --timeout=300s
KUBECONFIG="${LOC_KUBECONFIG}" "${ROOT}/operator/install.sh"

echo "==> api on the control plane"
# function-tuskpilot from this checkout, not the published package.
local_function_tuskpilot "${CP}" "${CP_KUBECONFIG}" "${WORK}" "${RUNTIME}"
KUBECONFIG="${CP_KUBECONFIG}" "${ROOT}/api/install/install.sh"

echo "==> register the location"
kind get kubeconfig --internal --name "${LOC}" \
  | sed "s#https://${LOC}-control-plane:6443#https://$(node_ip "${LOC}"):6443#" >"${WORK}/loc-internal.kubeconfig"
KUBECONFIG="${CP_KUBECONFIG}" "${ROOT}/api/install/add-location.sh" "${LOCATION}" "${WORK}/loc-internal.kubeconfig"
if ! "${C[@]}" wait location/${LOCATION} --for=condition=Ready --timeout=300s; then
  "${C[@]}" get location ${LOCATION} -o yaml; exit 1
fi

echo "==> project-defaults: remote write through the control plane's ingress (nip.io: ${CP_IP})"
"${C[@]}" apply -f - <<YAML
apiVersion: apiextensions.crossplane.io/v1beta1
kind: EnvironmentConfig
metadata:
  name: project-defaults
data:
  prometheus:
    remoteWrite:
      hostTemplate: prometheus-{project}.${CP_IP}.nip.io
      scheme: http
      className: haproxy
YAML

echo "==> Project demo (no Grafana ingress on kind)"
"${C[@]}" apply -f - <<YAML
apiVersion: platform.cndev.nl/v1alpha1
kind: Project
metadata:
  name: demo
spec:
  owner: team-demo
  locations:
    protected: ${LOCATION}
  access:
    - group: demo-devs
      role: edit
  observability:
    prometheus:
      retention: 1d
      storage:
        size: 1Gi
      resources:
        requests:
          cpu: 50m
          memory: 256Mi
        limits:
          memory: 1Gi
    grafana:
      ingress: false
YAML

echo "==> reserved Project names and Projects without a location are rejected by the XRD"
for project in "kube-evil:{locations: {protected: ${LOCATION}}}" "no-location:{owner: x}"; do
  if "${C[@]}" apply --dry-run=server -f - 2>/dev/null <<YAML
apiVersion: platform.cndev.nl/v1alpha1
kind: Project
metadata: {name: ${project%%:*}}
spec: ${project#*:}
YAML
  then
    echo "FAIL: Project ${project%%:*} was accepted"; exit 1
  fi
done

echo "==> waiting for Project Ready (Prometheus + Grafana pull images, in both clusters)"
if ! "${C[@]}" wait project/demo --for=condition=Ready --timeout=600s; then
  "${C[@]}" get project demo -o yaml
  "${C[@]}" -n demo get prometheus,grafana,grafanadatasource,pods,objects.kubernetes.m.crossplane.io
  "${L[@]}" -n demo get prometheus,pods
  exit 1
fi
"${C[@]}" get project demo
"${C[@]}" get project demo -o jsonpath='{.status}' | jq .
"${L[@]}" get namespace demo --show-labels
"${L[@]}" -n demo get rolebinding -l platform.cndev.nl/project=demo -o wide

echo "==> PostgresCluster demo/orders-db (1 instance to fit kind)"
"${C[@]}" apply -f - <<'PGC'
apiVersion: cnpg.cndev.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: orders-db
  namespace: demo
spec:
  instances: 1
  storage:
    size: 1Gi
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      memory: 512Mi
  pooler:
    enabled: true
    instances: 1
  databases:
    - name: reporting
      owner: app
      extensions: [pg_stat_statements]
PGC

echo "==> waiting for PostgresCluster Ready (pulls the PostgreSQL image; can take a few minutes)"
if ! "${C[@]}" -n demo wait postgrescluster/orders-db --for=condition=Ready --timeout=600s; then
  "${C[@]}" -n demo get postgrescluster orders-db -o yaml
  "${C[@]}" -n demo get objects.kubernetes.m.crossplane.io,grafanadashboard
  "${L[@]}" -n demo get cluster,pooler,database,podmonitor,prometheusrule,pods
  exit 1
fi
"${C[@]}" -n demo get postgrescluster orders-db -o jsonpath='{.status}' | jq .
"${L[@]}" -n demo get cluster,pooler,database,podmonitor,prometheusrule,pods
if "${C[@]}" get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
  echo "FAIL: CloudNativePG on the control plane; it must run no databases"; exit 1
fi

echo "==> connecting through the pooler with the generated app credentials (in the location)"
"${L[@]}" -n demo exec orders-db-1 -c postgres -- \
  psql "$("${L[@]}" -n demo get secret orders-db-app -o jsonpath='{.data.uri}' | base64 -d | sed 's/orders-db-rw/orders-db-pooler-rw/')" \
  -c 'select version();'

echo "==> metrics endpoint"
"${L[@]}" get --raw /api/v1/namespaces/demo/pods/orders-db-1:9187/proxy/metrics | grep -m3 '^cnpg_collector_up'

prom_query() { # <kubeconfig> <query>
  kubectl --kubeconfig "$1" get --raw "/api/v1/namespaces/demo/services/prometheus-operated:9090/proxy/api/v1/query?query=$2"
}
# cnpg_collector_up{cluster="orders-db"}, URL-encoded.
query='cnpg_collector_up%7Bcluster%3D%22orders-db%22%7D'
echo "==> the location's Prometheus scrapes the database"
if ! wait_for "cnpg_collector_up in the location's Prometheus" 30 bash -c \
    "$(declare -f prom_query); prom_query '${LOC_KUBECONFIG}' '${query}' | grep -q '\"value\"'"; then
  prom_query "${LOC_KUBECONFIG}" up; exit 1
fi
echo "==> ... and writes it to the project's Prometheus on the control plane, labelled with its location"
if ! wait_for "cnpg_collector_up from ${LOCATION} on the control plane" 30 bash -c \
    "$(declare -f prom_query); prom_query '${CP_KUBECONFIG}' '${query}' | grep -q '\"location\":\"${LOCATION}\"'"; then
  prom_query "${CP_KUBECONFIG}" "${query}"; "${C[@]}" -n demo get ingress prometheus-remote-write -o wide; exit 1
fi
prom_query "${CP_KUBECONFIG}" "${query}"; echo

echo "==> the project's Grafana has the datasource and the cluster's dashboard"
uid="$("${C[@]}" -n demo get postgrescluster orders-db -o jsonpath='{.status.monitoring.dashboardUid}')"
grafana() {
  kubectl --kubeconfig "${CP_KUBECONFIG}" get --raw "/api/v1/namespaces/demo/services/grafana-service:3000/proxy/api/$1"
}
if ! wait_for "dashboard ${uid} in the project's Grafana" 30 bash -c \
    "$(declare -f grafana); CP_KUBECONFIG='${CP_KUBECONFIG}'; grafana 'dashboards/uid/${uid}' | grep -q '\"uid\":\"${uid}\"'"; then
  "${C[@]}" -n demo get grafanadashboard -o yaml; exit 1
fi
grafana datasources/name/prometheus | grep -q '"isDefault":true'
echo "dashboard ${uid} and datasource prometheus present"

echo "==> guardrails: a protected Project and its namespace can't be deleted"
if "${C[@]}" delete project demo --wait=false 2>/dev/null; then
  echo "FAIL: protected Project was deleted"; exit 1
fi
if out="$("${C[@]}" delete namespace demo --wait=false 2>&1)"; then
  echo "FAIL: project namespace was deleted directly"; exit 1
fi
grep -q 'delete the Project instead' <<<"${out}"
"${C[@]}" get project demo >/dev/null

echo "==> deleting the PostgresCluster cascades to every composed object, in the location too"
"${C[@]}" -n demo delete postgrescluster orders-db --wait --timeout=180s
wait_for "orders-db gone from the location" 30 bash -c \
  "kubectl --kubeconfig '${LOC_KUBECONFIG}' -n demo get cluster,pooler,podmonitor,prometheusrule 2>&1 | grep -q 'No resources found'"
"${C[@]}" -n demo get grafanadashboard 2>&1 | grep -q "No resources found"

echo "==> deleting the Project after turning off deletion protection removes its namespace here, keeps it in the location"
"${C[@]}" patch project demo --type merge -p '{"spec":{"deletionProtection":false}}'
"${C[@]}" delete project demo --wait --timeout=300s
wait_for "namespace demo gone from the control plane" 30 bash -c "! kubectl --kubeconfig '${CP_KUBECONFIG}' get namespace demo"
"${L[@]}" get namespace demo >/dev/null

echo "E2E PASSED"
