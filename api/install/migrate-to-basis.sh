#!/usr/bin/env bash
# One-off: moves a control plane installed before the rename from the
# "cnpg" names to the "basis" ones, against your current context:
#
#   cnpg.cndev.nl (PostgresCluster)   -> postgres.cndev.nl
#   cnpg-platform:* ClusterRoles      -> basis:*  (bindings of yours are moved)
#   cnpg-locations (kubeconfigs)      -> basis-locations
#   function-go-templating            -> gone (Project and Location are Go now)
#
# and installs what's new (ModelGateway, the GenAIStack ownership policy)
# with install.sh. It needs function-basis v0.4.0 or later published (or
# FUNCTION_MANIFEST pointing at a manifest for one), and no PostgresCluster of
# the old group: a Composition's compositeTypeRef can't change, so the old
# PostgresCluster API is deleted, not converted. With PostgresClusters left it
# stops and says so. Idempotent: re-running skips what's done.
#
#   api/install/migrate-to-basis.sh
#   CLEAN_LOCATIONS=false api/install/migrate-to-basis.sh   # leave the old RBAC in the locations
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLD_NS="${OLD_LOCATIONS_NAMESPACE:-cnpg-locations}"
NEW_NS="${LOCATIONS_NAMESPACE:-basis-locations}"
CLEAN_LOCATIONS="${CLEAN_LOCATIONS:-true}"

# ---- 1. the old PostgresCluster API, while nothing uses it
if kubectl get crd postgresclusters.cnpg.cndev.nl >/dev/null 2>&1; then
  remaining="$(kubectl get postgresclusters.cnpg.cndev.nl -A --no-headers 2>/dev/null | wc -l)"
  if [[ "${remaining}" -gt 0 ]]; then
    echo "ERROR: ${remaining} PostgresCluster(s) of cnpg.cndev.nl still exist:" >&2
    kubectl get postgresclusters.cnpg.cndev.nl -A >&2
    echo "Back them up (a restore from the bucket recreates them under postgres.cndev.nl) and delete them first." >&2
    exit 1
  fi
  echo "==> Removing the cnpg.cndev.nl PostgresCluster API (no clusters use it)"
  kubectl delete composition postgrescluster --ignore-not-found
  kubectl delete xrd postgresclusters.cnpg.cndev.nl --ignore-not-found --wait
fi
for vap in cnpg.cndev.nl-postgrescluster-size cnpg.cndev.nl-postgrescluster-extensions; do
  kubectl delete validatingadmissionpolicybinding "${vap}" --ignore-not-found
  kubectl delete validatingadmissionpolicy "${vap}" --ignore-not-found
done

# ---- 2. everything under the new names
echo "==> install.sh"
"${SCRIPT_DIR}/install.sh"

# ---- 3. bindings of yours to the old roles, re-pointed at the new ones
echo "==> Bindings to cnpg-platform:* roles"
kubectl get clusterrolebindings,rolebindings -A -o json | jq -c '
  .items[] | select(.roleRef.name | startswith("cnpg-platform:"))
  | select((.metadata.labels["app.kubernetes.io/managed-by"] // "") != "crossplane")' | while read -r b; do
  kind="$(jq -r .kind <<<"${b}")" name="$(jq -r .metadata.name <<<"${b}")" ns="$(jq -r '.metadata.namespace // ""' <<<"${b}")"
  # A roleRef can't change: delete the binding, then create it again (named
  # with basis: for cnpg-platform:) pointing at the new role.
  new="$(jq '{apiVersion, kind, metadata: {name: (.metadata.name | sub("cnpg-platform"; "basis")),
        namespace: .metadata.namespace, labels: .metadata.labels},
       roleRef: (.roleRef | .name |= sub("^cnpg-platform:"; "basis:")), subjects}
      | del(..|nulls)' <<<"${b}")"
  echo "    ${kind} ${ns:+${ns}/}${name} -> $(jq -r .roleRef.name <<<"${new}")"
  kubectl delete "${kind,,}" "${name}" ${ns:+-n "${ns}"}
  kubectl create -f - <<<"${new}"
done
echo "==> Old ClusterRoles"
kubectl get clusterroles -o name | grep -E '/(cnpg-platform:|crossplane:composed:cnpg-platform)' | xargs -r kubectl delete

# ---- 4. the locations' kubeconfigs, into the new namespace
if kubectl get namespace "${OLD_NS}" >/dev/null 2>&1; then
  echo "==> Location kubeconfigs: ${OLD_NS} -> ${NEW_NS}"
  kubectl create namespace "${NEW_NS}" --dry-run=client -o yaml | kubectl apply -f -
  kubectl get locations.platform.cndev.nl -o json | jq -r --arg ns "${OLD_NS}" \
    '.items[] | select(.spec.credentials.secretRef.namespace == $ns) | "\(.metadata.name) \(.spec.credentials.secretRef.name)"' |
    while read -r location secret; do
      kubectl -n "${OLD_NS}" get secret "${secret}" -o json |
        jq --arg ns "${NEW_NS}" 'del(.metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp, .metadata.managedFields, .metadata.ownerReferences) | .metadata.namespace = $ns' |
        kubectl apply -f -
      kubectl patch locations.platform.cndev.nl "${location}" --type merge \
        -p "{\"spec\":{\"credentials\":{\"secretRef\":{\"namespace\":\"${NEW_NS}\"}}}}"
      kubectl wait locations.platform.cndev.nl "${location}" --for=condition=Ready --timeout=300s
      kubectl -n "${OLD_NS}" delete secret "${secret}"
    done
  if [[ -z "$(kubectl -n "${OLD_NS}" get secrets -o name 2>/dev/null)" ]]; then
    kubectl delete namespace "${OLD_NS}"
  else
    echo "    ${OLD_NS} still has Secrets no Location uses; left in place" >&2
  fi
fi

# ---- 5. function-go-templating composed Project and Location before
echo "==> Projects and Locations on function-basis"
kubectl wait projects.platform.cndev.nl --all --for=condition=Ready --timeout=600s || true
kubectl delete function.pkg.crossplane.io function-go-templating --ignore-not-found

# ---- 6. the old RBAC in each location (what replaced it is there by now)
if [[ "${CLEAN_LOCATIONS}" == "true" ]]; then
  tmp="$(mktemp)"
  trap 'rm -f "${tmp}"' EXIT
  kubectl get locations.platform.cndev.nl -o json | jq -r '.items[] | "\(.metadata.name) \(.spec.credentials.secretRef.namespace) \(.spec.credentials.secretRef.name) \(.spec.credentials.secretRef.key // "kubeconfig")"' |
    while read -r location ns secret key; do
      kubectl -n "${ns}" get secret "${secret}" -o jsonpath="{.data.${key}}" | base64 -d >"${tmp}"
      if ! KUBECONFIG="${tmp}" kubectl get clusterrole basis:project-prometheus >/dev/null 2>&1; then
        echo "    ${location}: basis:project-prometheus not there yet; skipped (re-run later)" >&2
        continue
      fi
      echo "==> ${location}: old Prometheus RBAC"
      # Each project's old binding, once its basis:project:<project>:prometheus is there.
      for old in $(KUBECONFIG="${tmp}" kubectl get clusterrolebindings -o name | grep -E '/platform:project:.*:prometheus$' || true); do
        project="${old#*/platform:project:}" project="${project%:prometheus}"
        if KUBECONFIG="${tmp}" kubectl get clusterrolebinding "basis:project:${project}:prometheus" >/dev/null 2>&1; then
          KUBECONFIG="${tmp}" kubectl delete "${old}"
        else
          echo "    ${location}: basis:project:${project}:prometheus not there yet; ${old} kept (re-run later)" >&2
        fi
      done
      if ! KUBECONFIG="${tmp}" kubectl get clusterrolebindings -o name | grep -qE '/platform:project:.*:prometheus$'; then
        KUBECONFIG="${tmp}" kubectl delete clusterrole cnpg-platform:project-prometheus --ignore-not-found
      fi
    done
fi

echo "==> Done"
kubectl get xrd
kubectl get locations.platform.cndev.nl,projects.platform.cndev.nl
