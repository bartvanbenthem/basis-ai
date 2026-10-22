#!/usr/bin/env bash
# Prints the environment to run BASIS Lens on this machine against a stack's
# external endpoints: its database (retrieval.expose) and its gateway
# (gateway.expose), both limited to their loadBalancerSourceRanges. The cache
# stays internal to the location, so the app runs without one.
#
#   eval "$(./local-env.sh <stack> <namespace> <location context>)"
#
# Reads the credentials from the control plane (the current kubectl context, or
# CP_CONTEXT) and the database's address and the basis CA from the location.
set -euo pipefail

STACK=${1:?stack}
NS=${2:?namespace}
LOC=${3:?kubectl context of the location}
cp=(kubectl -n "${NS}")
[[ -n "${CP_CONTEXT:-}" ]] && cp=(kubectl --context "${CP_CONTEXT}" -n "${NS}")
loc=(kubectl --context "${LOC}")

secret() { "${cp[@]}" get secret "$1" -o jsonpath="{.data.$2}" | base64 -d; }

db_ip=$("${loc[@]}" -n "${NS}" get svc "${STACK}-db-external" -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
[[ -n "${db_ip}" ]] || { echo "no external address for ${STACK}-db: set retrieval.expose on the stack" >&2; exit 1; }
gw=$("${cp[@]}" get modelgateway "${STACK}-gateway" -o jsonpath='{.status.externalEndpoint}')
[[ -n "${gw}" ]] || { echo "no external endpoint for ${STACK}-gateway: set gateway.expose on the stack" >&2; exit 1; }

user=$(secret "${STACK}-db-credentials" username)
pass=$(secret "${STACK}-db-credentials" password | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')

# The basis ClusterIssuer is a private CA (deps/agent-router/clusterissuer.yaml)
ca="${TMPDIR:-/tmp}/basis-ca-${LOC}.crt"
"${loc[@]}" -n cert-manager get secret basis-ca -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d > "${ca}" || true

printf 'export DATABASE_URL=%q\n' "postgresql://${user}:${pass}@${db_ip}:5432/app?sslmode=require"
printf 'export OPENAI_BASE_URL=%q\n' "${gw}"
printf 'export OPENAI_API_KEY=%q\n' "$(secret "${STACK}-gateway-keys" apps)"
[[ -s "${ca}" ]] && printf 'export OPENAI_CA_FILE=%q\n' "${ca}"
printf 'export SITE=local VALKEY_HOST=\n'
