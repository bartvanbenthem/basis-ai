#!/usr/bin/env bash
# End-to-end test of a Project's two sites on three throwaway kind clusters:
# "control plane" (Crossplane, the APIs, MinIO as the shared object store; no
# CloudNativePG, it runs no databases), "protected" and "recovery"
# (registered as locations e2e-protected and e2e-recovery). Checks that
#
#   - both Locations connect and find CloudNativePG and the Prometheus
#     Operator CRDs there
#   - a Project with spec.locations {protected, recovery} creates its
#     namespace in both
#   - a PostgresCluster with geoReplication runs its primary in the protected
#     location and a replica cluster in the recovery location, which replays
#     the primary's WAL from the object store: data written in the protected
#     location shows up in the recovery location
#   - a new PostgresCluster with spec.restore recovers from that cluster's
#     backup folder up to a point in time (rows written after it are absent),
#     and archives to a folder of its own; restore can't be added or changed
#     later
#   - switching geoReplication.primarySite to recovery demotes the old
#     primary and promotes the replica cluster with its demotion token
#     (writes then work there, and the old primary follows)
#   - switching geoReplication off while the primary is in the recovery site
#     switches it back to the protected site first, then removes the replica
#     cluster
#   - the XRD rules and the location admission policy reject what they should
#     (no database outside a Project, no geo replication without backups,
#     sites can't change), a Location in use can't be deleted, and a closed
#     (unschedulable) recovery location takes no new replica clusters
#
# Monitoring is off (no Prometheus/Grafana) to keep three clusters small;
# hack/e2e-kind.sh covers that part.
#
# Uses its own kubeconfig files (never touches your current context):
#   hack/e2e-locations.sh             # create clusters, install, test, delete
#   KEEP=true hack/e2e-locations.sh   # leave the clusters running afterwards
#
# Rootless podman works: KIND_EXPERIMENTAL_PROVIDER=podman hack/e2e-locations.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/function-basis.sh
source "${ROOT}/hack/lib/function-basis.sh"
CP="${CONTROL_PLANE_CLUSTER:-basis-e2e-cp}"
PROT="${PROTECTED_CLUSTER:-basis-e2e-protected}"
REC="${RECOVERY_CLUSTER:-basis-e2e-recovery}"
PROTECTED=e2e-protected
RECOVERY=e2e-recovery
WORK="${ROOT}/.e2e"
mkdir -p "${WORK}"
CP_KUBECONFIG="${WORK}/cp.kubeconfig"
PROT_KUBECONFIG="${WORK}/protected.kubeconfig"
REC_KUBECONFIG="${WORK}/recovery.kubeconfig"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.2}"
NS=ledger

# Several kind clusters run out of inotify instances at the default 128: the
# operators then crash with "too many open files".
if [[ "$(sysctl -n fs.inotify.max_user_instances 2>/dev/null || echo 512)" -lt 512 ]]; then
  echo "ERROR: fs.inotify.max_user_instances is below 512; three kind clusters need more:" >&2
  echo "  sudo sysctl fs.inotify.max_user_instances=512" >&2
  exit 1
fi

# Container runtime kind uses, for the node IPs.
RUNTIME=docker
if [[ "${KIND_EXPERIMENTAL_PROVIDER:-}" == "podman" ]] || ! command -v docker >/dev/null; then
  RUNTIME=podman
fi

for c in "${CP}:${CP_KUBECONFIG}" "${PROT}:${PROT_KUBECONFIG}" "${REC}:${REC_KUBECONFIG}"; do
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
    kind delete cluster --name "${PROT}" --kubeconfig "${PROT_KUBECONFIG}" || true
    kind delete cluster --name "${REC}" --kubeconfig "${REC_KUBECONFIG}" || true
  fi
}
trap cleanup EXIT

C=(kubectl --kubeconfig "${CP_KUBECONFIG}")
P=(kubectl --kubeconfig "${PROT_KUBECONFIG}")
R=(kubectl --kubeconfig "${REC_KUBECONFIG}")
node_ip() { "${RUNTIME}" inspect -f '{{ (index .NetworkSettings.Networks "kind").IPAddress }}' "$1-control-plane"; }

wait_for() { # <description> <tries> <command...>: retry every 10s
  local what="$1" tries="$2"; shift 2
  for _ in $(seq 1 "${tries}"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 10
  done
  echo "FAIL: ${what}"; return 1
}

echo "==> cert-manager, Prometheus Operator CRDs (no operator) + operator in both locations"
for kc in "${PROT_KUBECONFIG}" "${REC_KUBECONFIG}"; do
  kubectl --kubeconfig "${kc}" apply --server-side \
    -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml" >/dev/null
  # The CNPG chart ships a PodMonitor for the operator.
  for crd in "${ROOT}"/api/tests/crds/monitoring.coreos.com_*.yaml; do
    kubectl --kubeconfig "${kc}" apply --server-side -f "${crd}" >/dev/null
  done
  kubectl --kubeconfig "${kc}" -n cert-manager wait deploy --all --for=condition=Available --timeout=300s
  KUBECONFIG="${kc}" "${ROOT}/deps/cnpg/install.sh"
done

echo "==> MinIO on the control plane (NodePort 30900, reachable from both locations)"
"${C[@]}" apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata:
  name: minio
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
  namespace: minio
spec:
  selector:
    matchLabels: {app: minio}
  template:
    metadata:
      labels: {app: minio}
    spec:
      containers:
        - name: minio
          image: quay.io/minio/minio:latest
          args: [server, /data]
          env:
            - {name: MINIO_ROOT_USER, value: e2e-access}
            - {name: MINIO_ROOT_PASSWORD, value: e2e-secret-key}
          ports:
            - containerPort: 9000
          readinessProbe:
            httpGet: {path: /minio/health/ready, port: 9000}
          volumeMounts:
            - {name: data, mountPath: /data}
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: minio
  namespace: minio
spec:
  type: NodePort
  selector: {app: minio}
  ports:
    - port: 9000
      nodePort: 30900
YAML
"${C[@]}" -n minio rollout status deploy/minio --timeout=300s
S3_ENDPOINT="http://$(node_ip "${CP}"):30900"
"${C[@]}" -n minio delete job mkbucket --ignore-not-found >/dev/null
"${C[@]}" -n minio create job mkbucket --image=quay.io/minio/mc:latest -- \
  sh -c "mc alias set e2e http://minio.minio.svc:9000 e2e-access e2e-secret-key && mc mb --ignore-existing e2e/pg-backups"
"${C[@]}" -n minio wait job/mkbucket --for=condition=Complete --timeout=180s

echo "==> api on the control plane"
# function-basis from this checkout, not the published package.
local_function_basis "${CP}" "${CP_KUBECONFIG}" "${WORK}" "${RUNTIME}"
KUBECONFIG="${CP_KUBECONFIG}" "${ROOT}/api/install/install.sh"
if "${C[@]}" get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
  echo "FAIL: the control plane has CloudNativePG; this test must show it doesn't need it"; exit 1
fi

for loc in "${PROTECTED}:${PROT}" "${RECOVERY}:${REC}"; do
  name="${loc%%:*}" cluster="${loc#*:}"
  echo "==> register ${cluster} as location ${name}"
  # The internal kubeconfig, with the node IP: what pods on the control
  # plane can reach.
  kind get kubeconfig --internal --name "${cluster}" \
    | sed "s#https://${cluster}-control-plane:6443#https://$(node_ip "${cluster}"):6443#" >"${WORK}/${name}-internal.kubeconfig"
  KUBECONFIG="${CP_KUBECONFIG}" "${ROOT}/api/install/add-location.sh" \
    "${name}" "${WORK}/${name}-internal.kubeconfig"
  if ! "${C[@]}" wait "location/${name}" --for=condition=Ready --timeout=300s; then
    "${C[@]}" get location "${name}" -o yaml; "${C[@]}" -n basis-locations get objects.kubernetes.m.crossplane.io -o wide; exit 1
  fi
done
"${C[@]}" get locations -o wide
"${P[@]}" get clusterrole basis:project-prometheus

echo "==> Project ${NS}: protected ${PROTECTED}, recovery ${RECOVERY}"
"${C[@]}" apply -f - <<YAML
apiVersion: platform.cndev.nl/v1alpha1
kind: Project
metadata:
  name: ${NS}
spec:
  owner: team-ledger
  deletionProtection: false
  locations:
    protected: ${PROTECTED}
    recovery: ${RECOVERY}
  access:
    - group: ledger-devs
      role: edit
  observability:
    prometheus:
      enabled: false
    grafana:
      enabled: false
YAML
if ! "${C[@]}" wait project/${NS} --for=condition=Ready --timeout=300s; then
  "${C[@]}" get project ${NS} -o yaml; "${C[@]}" -n ${NS} get objects.kubernetes.m.crossplane.io -o wide; exit 1
fi
"${C[@]}" get project ${NS}
"${C[@]}" get namespace ${NS} -o jsonpath='{.metadata.annotations}'; echo
for kc in "${PROT_KUBECONFIG}" "${REC_KUBECONFIG}"; do
  kubectl --kubeconfig "${kc}" get namespace ${NS} --show-labels
  kubectl --kubeconfig "${kc}" -n ${NS} get rolebinding -l platform.cndev.nl/project=${NS}
done

echo "==> guardrails"
reject() { # <what> <expected message part>: stdin must be refused by --dry-run=server
  local out
  if out="$("${C[@]}" apply --dry-run=server -f - 2>&1)"; then
    echo "FAIL: ${1} was accepted"; exit 1
  fi
  grep -q "$2" <<<"${out}" || { echo "FAIL: ${1}: unexpected error: ${out}"; exit 1; }
  echo "rejected as expected: ${1}"
}
"${C[@]}" create namespace not-a-project --dry-run=client -o yaml | "${C[@]}" apply -f - >/dev/null
reject "a database outside a Project (on the control plane)" "never on the control plane" <<YAML
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata: {name: stray-db, namespace: not-a-project}
spec: {instances: 1}
YAML
reject "geoReplication without backups" "geoReplication needs backup.enabled" <<YAML
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata: {name: nobackup-db, namespace: ${NS}}
spec:
  geoReplication: {enabled: true}
YAML
reject "a recovery primary without geoReplication" "primarySite can only be recovery" <<YAML
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata: {name: noprimary-db, namespace: ${NS}}
spec:
  geoReplication: {primarySite: recovery}
YAML
reject "changing the Project's protected location" "locations.protected can't be changed" <<YAML
apiVersion: platform.cndev.nl/v1alpha1
kind: Project
metadata: {name: ${NS}}
spec: {locations: {protected: ${RECOVERY}, recovery: ${PROTECTED}}}
YAML
reject "removing the Project's recovery location" "can be added, but not changed or removed" <<YAML
apiVersion: platform.cndev.nl/v1alpha1
kind: Project
metadata: {name: ${NS}}
spec: {locations: {protected: ${PROTECTED}}}
YAML
if out="$("${C[@]}" delete location ${RECOVERY} --dry-run=server 2>&1)"; then
  echo "FAIL: deleting Location ${RECOVERY} while Project ${NS} uses it was accepted"; exit 1
fi
grep -q "in-use" <<<"${out}" || { echo "FAIL: deleting a Location in use: unexpected error: ${out}"; exit 1; }
echo "rejected as expected: deleting a Location a Project uses"

"${C[@]}" patch location ${RECOVERY} --type merge -p '{"spec":{"schedulable":false}}'
wait_for "namespace ${NS} lists ${RECOVERY} as unschedulable" 30 bash -c \
  "[[ \$(kubectl --kubeconfig '${CP_KUBECONFIG}' get ns ${NS} -o jsonpath='{.metadata.annotations.platform\.cndev\.nl/unschedulable-locations}') == ${RECOVERY} ]]"
reject "a new replica cluster in a closed location" "closed to new replica clusters" <<YAML
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata: {name: closed-db, namespace: ${NS}}
spec:
  geoReplication: {enabled: true}
  backup: {enabled: true, destinationPath: "s3://pg-backups/x", s3Credentials: {secretName: x}}
YAML
"${C[@]}" patch location ${RECOVERY} --type merge -p '{"spec":{"schedulable":true}}'
wait_for "namespace ${NS} without unschedulable locations" 30 bash -c \
  "[[ -z \$(kubectl --kubeconfig '${CP_KUBECONFIG}' get ns ${NS} -o jsonpath='{.metadata.annotations.platform\.cndev\.nl/unschedulable-locations}') ]]"

echo "==> PostgresCluster ${NS}/ledger-db: primary in ${PROTECTED}, replica cluster in ${RECOVERY}"
"${C[@]}" -n ${NS} create secret generic ledger-db-s3 \
  --from-literal=ACCESS_KEY_ID=e2e-access --from-literal=ACCESS_SECRET_KEY=e2e-secret-key \
  --dry-run=client -o yaml | "${C[@]}" apply -f -
"${C[@]}" apply -f - <<YAML
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: ledger-db
  namespace: ${NS}
spec:
  instances: 1
  storage:
    size: 1Gi
  resources:
    requests: {cpu: 100m, memory: 256Mi}
    limits: {memory: 512Mi}
  geoReplication:
    enabled: true
  backup:
    enabled: true
    destinationPath: s3://pg-backups/e2e
    endpointURL: ${S3_ENDPOINT}
    s3Credentials:
      secretName: ledger-db-s3
  monitoring:
    enabled: false
    grafanaDashboard:
      enabled: false
YAML

echo "==> waiting for PostgresCluster Ready in both sites (image pulls, first base backup)"
if ! "${C[@]}" -n ${NS} wait postgrescluster/ledger-db --for=condition=Ready --timeout=900s; then
  "${C[@]}" -n ${NS} get postgrescluster ledger-db -o yaml
  "${C[@]}" -n ${NS} get objects.kubernetes.m.crossplane.io -o wide
  for kc in "${PROT_KUBECONFIG}" "${REC_KUBECONFIG}"; do
    kubectl --kubeconfig "${kc}" -n ${NS} get cluster,objectstore,scheduledbackup,backup,secret,pods || true
    kubectl --kubeconfig "${kc}" -n ${NS} describe cluster ledger-db | tail -30 || true
  done
  exit 1
fi
"${C[@]}" -n ${NS} get postgrescluster ledger-db
"${C[@]}" -n ${NS} get postgrescluster ledger-db -o jsonpath='{.status.locations}' | jq .
if "${C[@]}" -n ${NS} get pods -l cnpg.io/cluster=ledger-db 2>/dev/null | grep -q ledger-db; then
  echo "FAIL: database pods on the control plane"; exit 1
fi
[[ "$("${C[@]}" -n ${NS} get postgrescluster ledger-db -o jsonpath='{.status.sites.protected}/{.status.sites.recovery}')" == "${PROTECTED}/${RECOVERY}" ]] \
  || { echo "FAIL: status.sites not pinned"; exit 1; }

psql_in() { # <kubectl...> <sql>: run as postgres in the cluster's current primary pod
  local k=("${@:1:$#-1}") sql="${!#}" pod
  pod="$("${k[@]}" -n ${NS} get cluster ledger-db -o jsonpath='{.status.currentPrimary}')"
  "${k[@]}" -n ${NS} exec "${pod}" -c postgres -- psql -U postgres -d app -tAc "${sql}"
}
site_is() { # <site> <location>: status.primarySite and status.primaryLocation
  [[ "$(kubectl --kubeconfig "${CP_KUBECONFIG}" -n ${NS} get postgrescluster ledger-db \
    -o jsonpath='{.status.primarySite}/{.status.primaryLocation}')" == "$1/$2" ]]
}
export -f psql_in site_is
export NS CP_KUBECONFIG

echo "==> data written in ${PROTECTED} reaches ${RECOVERY} through the WAL archive"
psql_in "${P[@]}" "create table if not exists e2e(v text); insert into e2e values ('from-protected'); select pg_switch_wal();" >/dev/null
wait_for "row from ${PROTECTED} in ${RECOVERY}" 60 bash -c \
  "psql_in kubectl --kubeconfig '${REC_KUBECONFIG}' 'select v from e2e' | grep -q from-protected"
echo "row replicated to ${RECOVERY}"
if psql_in "${R[@]}" "insert into e2e values ('nope')" 2>/dev/null; then
  echo "FAIL: the replica cluster accepted a write"; exit 1
fi

echo "==> restore: a new PostgresCluster from ledger-db's backup folder, to a point in time"
psql_in "${P[@]}" "insert into e2e values ('before-target'); select pg_switch_wal();" >/dev/null
sleep 3
TARGET="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sleep 3
psql_in "${P[@]}" "insert into e2e values ('after-target'); select pg_switch_wal();" >/dev/null
reject "adding restore to an existing cluster" "restore can only be set when the cluster is created" <<YAML
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata: {name: ledger-db, namespace: ${NS}}
spec:
  restore: {source: {serverName: ledger-db}}
YAML
"${C[@]}" apply -f - <<YAML
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: ledger-copy
  namespace: ${NS}
spec:
  instances: 1
  storage:
    size: 1Gi
  resources:
    requests: {cpu: 100m, memory: 256Mi}
    limits: {memory: 512Mi}
  # Archives to the same store, in a folder of its own.
  backup:
    enabled: true
    destinationPath: s3://pg-backups/e2e
    endpointURL: ${S3_ENDPOINT}
    s3Credentials:
      secretName: ledger-db-s3
  restore:
    source:
      serverName: ledger-db
      destinationPath: s3://pg-backups/e2e
      endpointURL: ${S3_ENDPOINT}
      s3Credentials:
        secretName: ledger-db-s3
    targetTime: "${TARGET}"
  monitoring:
    enabled: false
    grafanaDashboard:
      enabled: false
YAML
if ! "${C[@]}" -n ${NS} wait postgrescluster/ledger-copy --for=condition=Ready --timeout=900s; then
  "${C[@]}" -n ${NS} get postgrescluster ledger-copy -o yaml
  "${P[@]}" -n ${NS} get cluster,objectstore,backup,pods || true
  "${P[@]}" -n ${NS} describe cluster ledger-copy | tail -30 || true
  "${P[@]}" -n ${NS} logs -l cnpg.io/cluster=ledger-copy --all-containers --tail=40 || true
  exit 1
fi
"${C[@]}" -n ${NS} get postgrescluster ledger-copy
copy_rows="$(pod="$("${P[@]}" -n ${NS} get cluster ledger-copy -o jsonpath='{.status.currentPrimary}')"; \
  "${P[@]}" -n ${NS} exec "${pod}" -c postgres -- psql -U postgres -d app -tAc 'select v from e2e order by v' | tr '\n' ' ')"
echo "restored rows: ${copy_rows}"
grep -q "before-target" <<<"${copy_rows}" && ! grep -q "after-target" <<<"${copy_rows}" \
  || { echo "FAIL: the restore didn't stop at ${TARGET}"; exit 1; }
folder="$("${C[@]}" -n ${NS} get postgrescluster ledger-copy -o jsonpath='{.status.backup.serverName}')"
[[ "${folder}" == ledger-copy-* ]] || { echo "FAIL: the restored cluster archives to ${folder}, not a folder of its own"; exit 1; }
wait_for "ledger-copy archives WAL to ${folder}" 30 bash -c \
  "kubectl --kubeconfig '${PROT_KUBECONFIG}' -n ${NS} get cluster ledger-copy -o jsonpath='{.status.conditions[?(@.type==\"ContinuousArchiving\")].status}' | grep -qx True"
psql_in "${P[@]}" "select v from e2e" | grep -q after-target \
  || { echo "FAIL: the source lost data"; exit 1; }
reject "changing restore on a restored cluster" "restore is immutable" <<YAML
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata: {name: ledger-copy, namespace: ${NS}}
spec:
  restore:
    source:
      serverName: ledger-db
      destinationPath: s3://pg-backups/e2e
      endpointURL: ${S3_ENDPOINT}
      s3Credentials: {secretName: ledger-db-s3}
YAML
"${C[@]}" -n ${NS} delete postgrescluster ledger-copy --wait --timeout=300s

echo "==> switchover: geoReplication.primarySite recovery"
"${C[@]}" -n ${NS} patch postgrescluster ledger-db --type merge -p '{"spec":{"geoReplication":{"primarySite":"recovery"}}}'
wait_for "primary in the recovery site" 60 site_is recovery "${RECOVERY}"
"${R[@]}" -n ${NS} get cluster ledger-db -o jsonpath='{.spec.replica}'; echo
wait_for "writes in ${RECOVERY}" 60 bash -c \
  "psql_in kubectl --kubeconfig '${REC_KUBECONFIG}' \"insert into e2e values ('from-recovery'); select pg_switch_wal();\""
echo "the new primary in ${RECOVERY} accepts writes"
wait_for "row from ${RECOVERY} back in ${PROTECTED}" 60 bash -c \
  "psql_in kubectl --kubeconfig '${PROT_KUBECONFIG}' 'select v from e2e' | grep -q from-recovery"
echo "the demoted cluster in ${PROTECTED} follows the new primary"
if ! "${C[@]}" -n ${NS} wait postgrescluster/ledger-db --for=condition=Ready --timeout=600s; then
  "${C[@]}" -n ${NS} get postgrescluster ledger-db -o yaml; exit 1
fi
"${C[@]}" -n ${NS} get postgrescluster ledger-db

echo "==> geoReplication off while the primary is in ${RECOVERY}: switch back first, then drop the replica cluster"
"${C[@]}" -n ${NS} patch postgrescluster ledger-db --type merge \
  -p '{"spec":{"geoReplication":{"enabled":false,"primarySite":"protected"}}}'
wait_for "primary back in the protected site" 60 site_is protected "${PROTECTED}"
wait_for "replica cluster in ${RECOVERY} gone" 60 bash -c "! kubectl --kubeconfig '${REC_KUBECONFIG}' -n ${NS} get cluster ledger-db"
wait_for "writes in ${PROTECTED} again" 30 bash -c \
  "psql_in kubectl --kubeconfig '${PROT_KUBECONFIG}' \"insert into e2e values ('protected-again')\""
psql_in "${P[@]}" "select v from e2e order by v" | tr '\n' ' '; echo
psql_in "${P[@]}" "select v from e2e" | grep -q from-recovery \
  || { echo "FAIL: writes made in ${RECOVERY} were lost switching back"; exit 1; }
if ! "${C[@]}" -n ${NS} wait postgrescluster/ledger-db --for=condition=Ready --timeout=600s; then
  "${C[@]}" -n ${NS} get postgrescluster ledger-db -o yaml; exit 1
fi

echo "==> deleting the PostgresCluster removes the cluster in ${PROTECTED}"
"${C[@]}" -n ${NS} delete postgrescluster ledger-db --wait --timeout=300s
wait_for "Cluster in ${PROTECTED} gone" 30 bash -c "! kubectl --kubeconfig '${PROT_KUBECONFIG}' -n ${NS} get cluster ledger-db"

echo "==> deleting the Project keeps its namespace in both locations"
"${C[@]}" delete project ${NS} --wait --timeout=300s
"${P[@]}" get namespace ${NS}
"${R[@]}" get namespace ${NS}

echo; echo "Locations e2e passed."
