#!/usr/bin/env bash
# One-off: turns locations registered before the Location API (a kubeconfig
# Secret labelled platform.cndev.nl/location=true, settings as JSON in its
# platform.cndev.nl/location-spec annotation, plus a ClusterProviderConfig the
# portal or add-location.sh created) into Location objects. Run it after
# install.sh, against the control plane (your current context).
#
# The Location composition takes over the existing ClusterProviderConfig of
# the same name (server-side apply), so Projects keep placing objects through
# it without interruption. Idempotent: existing Locations are left alone.
set -euo pipefail

LOCATIONS_NAMESPACE="${LOCATIONS_NAMESPACE:-basis-locations}"

kubectl wait xrd/locations.platform.cndev.nl --for=condition=Established --timeout=30s >/dev/null

kubectl -n "${LOCATIONS_NAMESPACE}" get secrets -l platform.cndev.nl/location=true -o json \
  | jq -c --arg ns "${LOCATIONS_NAMESPACE}" '
["displayName", "description", "environment", "provider", "region", "owner",
 "storageClass", "schedulable"] as $fields
| {apiVersion: "v1", kind: "List", items: [.items[] | .metadata.name as $name
    | ((.metadata.annotations["platform.cndev.nl/location-spec"] // "{}")
       | try (fromjson | if type == "object" then . else error end)
         catch ("WARNING: \($name): unreadable location-spec annotation, settings skipped\n" | stderr | {})) as $old
    | {apiVersion: "platform.cndev.nl/v1alpha1", kind: "Location", metadata: {name: $name},
       spec: (([$fields[] as $k | select($old[$k] != null and $old[$k] != "") | {($k): $old[$k]}] | add // {})
              + {credentials: {secretRef: {namespace: $ns, name: $name, key: "kubeconfig"}}})}]}
' >"${TMPDIR:-/tmp}/locations.$$.json"
trap 'rm -f "${TMPDIR:-/tmp}/locations.$$.json"' EXIT

# create, not apply: a Location that already exists keeps its settings.
kubectl create -f "${TMPDIR:-/tmp}/locations.$$.json" 2>&1 | sed 's/^Error from server (AlreadyExists): /skipped: /' || true
echo "==> Locations"
kubectl get locations.platform.cndev.nl
