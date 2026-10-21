#!/usr/bin/env bash
# Offline check: lints and renders the vendored charts with the production
# values. No cluster needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

helm lint "${SCRIPT_DIR}/charts/cloudnative-pg" -f "${SCRIPT_DIR}/values/cloudnative-pg.yaml"
helm lint "${SCRIPT_DIR}/charts/plugin-barman-cloud" -f "${SCRIPT_DIR}/values/plugin-barman-cloud.yaml"

helm template cnpg "${SCRIPT_DIR}/charts/cloudnative-pg" -n cnpg-system \
  -f "${SCRIPT_DIR}/values/cloudnative-pg.yaml" >/dev/null
helm template barman-cloud "${SCRIPT_DIR}/charts/plugin-barman-cloud" -n cnpg-system \
  -f "${SCRIPT_DIR}/values/plugin-barman-cloud.yaml" >/dev/null

echo "OK: charts render"
