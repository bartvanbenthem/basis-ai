#!/usr/bin/env bash
# Re-renders ../monitoring/alerts/cnpg-cluster-rules.yaml from the upstream
# cnpg/cluster Helm chart's PrometheusRule, with placeholder names that
# function-basis swaps for each cluster's. Run, review the diff,
# re-check monitoring/alerts/local-rules.yaml (our replacements for some of these
# rules), then `make generate`.
#
#   CLUSTER_CHART_VERSION=0.9.0 hack/refresh-alerts.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${SCRIPT_DIR}/../monitoring/alerts/cnpg-cluster-rules.yaml"
CLUSTER_CHART_VERSION="${CLUSTER_CHART_VERSION:-}"

helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo update cnpg >/dev/null

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

helm pull cnpg/cluster ${CLUSTER_CHART_VERSION:+--version "${CLUSTER_CHART_VERSION}"} --untar --untardir "${tmp}"
version="$(grep '^version:' "${tmp}/cluster/Chart.yaml" | awk '{print $2}')"

helm template xrel "${tmp}/cluster" -n zznamespacezz \
  --set fullnameOverride=zzclusterzz \
  --set cluster.monitoring.enabled=true \
  --set cluster.monitoring.prometheusRule.enabled=true \
  --show-only templates/prometheus-rule.yaml > "${tmp}/rule.yaml"

(cd "${SCRIPT_DIR}/.." && cargo run -q -p basis-tools --bin alertrules -- "${tmp}/rule.yaml" "${OUT}" "${version}")
