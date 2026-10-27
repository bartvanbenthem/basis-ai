# Dependencies

Every operator the platform builds on, installed before
[`api/`](../api/), the platform-wide
Project settings (`control-plane/project-defaults.yaml`), plus the
`demo` Project (a namespace with its own Prometheus and Grafana). The
platform has a **control plane** (Crossplane, the APIs, the portal, each
Project's Grafana; no databases) and **locations**, the clusters the
databases run in. Each component goes where its column says.

| Component | Needed for | Control plane | Locations |
|---|---|---|---|
| CloudNativePG + Barman Cloud plugin ([`cnpg/`](cnpg/README.md)) | `PostgresCluster` (and the portal's own database) | only for the portal's own database | where databases run |
| cert-manager | barman-cloud backup plugin; certificates of exposed model gateways | only for the portal's own database | yes, unless `INSTALL_BARMAN=false` and no gateway is exposed |
| Prometheus Operator | `Prometheus` per Project; `PodMonitor` / `PrometheusRule` per PostgresCluster | yes (the Prometheus the locations write to) | yes |
| grafana-operator | `Grafana` per Project, `GrafanaDashboard` per PostgresCluster | yes | no |
| HAProxy Ingress | Grafana from outside, and the remote-write endpoint the locations' Prometheus send to | yes | no |
| Valkey operator | `ValkeyCache` (exact and semantic caches) | no | where caches run |
| Envoy Gateway + Agent Router | `ModelGateway` (an internal, OpenAI-compatible endpoint per gateway and site, optionally exposed over HTTPS; every GenAIStack has one) | no | where gateways and stacks run |
| KServe (LLMInferenceService) + llm-d's scheduler | `ModelServer` (vLLM, prefix-cache-aware routing behind an InferencePool) | no | where self-hosted models run (GPU nodes) |

Install them in the order below, each in the clusters its row says. Upgrading
an operator whose kinds the APIs write also means refreshing its CRD in
`api/tests/crds/`, so the render tests validate against it ([Develop](../api/README.md#develop)).

## 1. cert-manager

```sh
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook
```

## 2. Prometheus Operator

`kube-prometheus-stack` is the community chart for the operator. The flags
turn off its own Prometheus, Alertmanager and Grafana. They keep
kube-state-metrics and node-exporter, which the CNPG dashboard's
CPU/memory panels need. The allowlist exports the nodes' zone label for the
dashboard's zone panel.

```sh
helm upgrade -i prometheus-operator kube-prometheus-stack \
  --repo https://prometheus-community.github.io/helm-charts \
  --version 89.2.0 -n prometheus-operator-system --create-namespace \
  --set prometheus.enabled=false \
  --set alertmanager.enabled=false \
  --set grafana.enabled=false \
  --set 'kube-state-metrics.metricLabelsAllowlist[0]=nodes=[topology.kubernetes.io/zone]'
```

Verify:

```sh
kubectl get pods -n prometheus-operator-system
kubectl get crd prometheuses.monitoring.coreos.com
```

## 3. CloudNativePG (locations with databases)

The CloudNativePG operator, the Barman Cloud backup plugin (WAL archiving and base backups) and the
PostgreSQL image catalog, installed from the charts vendored in [`cnpg/`](cnpg/README.md), never from
a remote Helm repository. It needs cert-manager (for the plugin) and the Prometheus Operator CRDs (for
the operator's PodMonitor), so it comes after steps 1 and 2:

```sh
KUBECONFIG=dc-a.kubeconfig deps/cnpg/install.sh   # CNPG 1.30, Barman Cloud plugin, image catalog
deps/cnpg/verify.sh                               # offline: the vendored charts lint and render
```

Install it in every location databases run in, and on the control plane for the portal's own
database. See [`cnpg/README.md`](cnpg/README.md) for upgrades and the production values.

## 4. grafana-operator

```sh
helm upgrade -i grafana-operator grafana-operator \
  --repo https://grafana.github.io/helm-charts \
  --version 5.25.0 -n grafana-operator-system --create-namespace
```

Verify:

```sh
kubectl get pods -n grafana-operator-system
kubectl get crd grafanas.grafana.integreatly.org
```

> **Use the HTTP repo above, not `oci://ghcr.io/grafana/helm-charts/...`.**
> For OCI charts, Helm uses the credentials in `~/.docker/config.json`. If
> that file has an expired or under-scoped `ghcr.io` login, ghcr rejects the
> pull with `403: denied`, even though the chart is public. To use OCI
> anyway, run `docker logout ghcr.io` (or `helm registry logout ghcr.io`)
> first.

## 5. HAProxy Ingress (optional)

On the control plane: the projects' Grafana and the remote-write endpoint
(`prometheus.remoteWrite` in `control-plane/project-defaults.yaml`) the locations'
Prometheus send their metrics through. Without it Grafana shows no
database metrics. Any `networking.k8s.io/v1` ingress controller works.

```sh
helm upgrade -i haproxy-ingress kubernetes-ingress \
  --repo https://haproxytech.github.io/helm-charts \
  --version 1.54.0 -n haproxy-ingress --create-namespace \
  --set controller.ingressClassResource.default=true \
  --set controller.service.type=LoadBalancer
```

The chart's default Service type is `NodePort`. Set it to `LoadBalancer`
explicitly to get a public IP. On SKE the cloud provider assigns it, so
MetalLB isn't needed.

```sh
kubectl get svc -n haproxy-ingress   # EXTERNAL-IP is where ingress hosts must resolve to
```

## 6. Valkey operator (locations with caches)

The official [valkey-io operator](https://github.com/valkey-io/valkey-operator)
runs the `ValkeyCluster`s that `ValkeyCache` places in one of a Project's
locations (its protected or recovery site) ([Caches](../portal/catalog/docs/caches/valkey.md)). Install it with its
default chart values in every location caches run in; the control plane
doesn't need it.

```sh
helm upgrade -i valkey-operator valkey-operator \
  --repo https://valkey.io/valkey-helm \
  --version 0.7.0 -n valkey-operator-system --create-namespace
```

Verify:

```sh
kubectl get pods -n valkey-operator-system
kubectl get crd valkeyclusters.valkey.io
```

The operator is v1alpha1 and marked early development upstream: cluster mode
only (no standalone or Sentinel), no backups, no modules of its own. The
`ValkeyCache` composition loads valkey-search for semantic caches through the
`valkey/valkey-bundle` image, and pins both images
([`function/valkeycache/compose.go`](../api/function/valkeycache/compose.go), a
new function-basis version); bump them together with this chart. Read the
[upgrade notes](https://github.com/valkey-io/valkey-helm/tree/main/valkey-operator)
before a chart upgrade: an operator upgrade can roll every cache's pods.

## 7. Envoy Gateway + Agent Router (locations with model gateways)

A `ModelGateway` (a GenAIStack's own, or a shared one) is [Agent Router](https://github.com/theagentrouter/agent-router)
(formerly Envoy AI Gateway; Apache-2.0, an Agentic AI Foundation project) on
[Envoy Gateway](https://gateway.envoyproxy.io) (Envoy, CNCF graduated). Install
both in every location gateways and stacks run in, at the versions Agent Router tests
together (Agent Router v1.2.x needs Envoy Gateway v1.9.2+), then the
GatewayClass the gateways use:

```sh
# The counters of the gateways' monthly token caps (Envoy Gateway's global
# rate limits), before Envoy Gateway, which is pointed at it.
kubectl create namespace envoy-gateway-system --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f agent-router/ratelimit-store.yaml

# Envoy Gateway (Gateway API + its CRDs), with Agent Router's settings and
# GatewayNamespace mode: each gateway's Envoy runs in its Project's namespace.
helm upgrade -i eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.9.2 -n envoy-gateway-system --create-namespace \
  -f agent-router/envoy-gateway-values.yaml
kubectl -n envoy-gateway-system wait deploy/envoy-gateway --for=condition=Available --timeout=5m

# Agent Router: its CRDs, then the controller
helm upgrade -i aieg-crd oci://docker.io/envoyproxy/ai-gateway-crds-helm \
  --version v1.2.0 -n envoy-ai-gateway-system --create-namespace
helm upgrade -i aieg oci://docker.io/envoyproxy/ai-gateway-helm \
  --version v1.2.0 -n envoy-ai-gateway-system
kubectl -n envoy-ai-gateway-system wait deploy/ai-gateway-controller --for=condition=Available --timeout=5m

kubectl apply -f agent-router/gatewayclass.yaml   # GatewayClass basis-ai

# For exposed gateways (spec.expose): the ClusterIssuer basis their
# certificates come from. This one is a private CA; see the file for ACME.
kubectl apply -f agent-router/clusterissuer.yaml
```

Verify:

```sh
kubectl get gatewayclass basis-ai                 # ACCEPTED True
kubectl get crd aigatewayroutes.aigateway.envoyproxy.io
kubectl get clusterissuer basis                   # READY True
```

Token caps (`monthlyTokens` on a ModelGateway, a client or a GenAIStack's gateway) are Envoy
Gateway global rate limits counted in `basis-ratelimit` (Valkey, a 1Gi volume): Envoy Gateway then
runs its rate limit service (`envoy-ratelimit`) in `envoy-gateway-system`. Each location counts on
its own. Without the store, the caps aren't enforced; everything else works.

An exposed gateway also needs `LoadBalancer` Services in the location (a cloud's load balancer, or
MetalLB and the like on-premises) that honour `loadBalancerSourceRanges`.

With an expired `ghcr.io` or
`docker.io` login in `~/.docker/config.json`, log out first (see step 4). The
charts and images keep their `envoyproxy` names after the project's rename.
Agent Router has no response cache: a stack's cache is used by the app, through
the connection Secret ([GenAI stacks](../portal/catalog/docs/ai/genai-stacks.md)).

## 8. KServe + llm-d (locations with self-hosted models)

A `ModelServer` is vLLM run by [KServe](https://kserve.github.io/website/)'s
`LLMInferenceService` controller (Apache-2.0), with
[llm-d](https://llm-d.ai/)'s inference scheduler (an endpoint picker behind a
Gateway API Inference Extension `InferencePool`) for prefix-cache-aware
routing. Install KServe's LLMInferenceService charts in every location
self-hosted models run in, after step 7 (Agent Router routes to the
servers), and let Envoy Gateway route to InferencePools there:

```sh
# CRDs (LLMInferenceService), then the controller with the InferencePool and
# llm-d CRDs, then its configuration presets (vLLM, the scheduler).
helm upgrade -i kserve-llmisvc-crd oci://ghcr.io/kserve/charts/kserve-llmisvc-crd \
  --version v0.21.0 -n kserve --create-namespace --wait
helm upgrade -i kserve-llmisvc-resources oci://ghcr.io/kserve/charts/kserve-llmisvc-resources \
  --version v0.21.0 -n kserve --set kserve.version=v0.21.0 --wait
kubectl -n kserve wait certificate/llmisvc-serving-cert --for=condition=Ready --timeout=3m
kubectl -n kserve rollout restart deploy/llmisvc-controller-manager   # mounts its webhook certificate
kubectl -n kserve rollout status deploy/llmisvc-controller-manager --timeout=5m
helm upgrade -i kserve-runtime-configs oci://ghcr.io/kserve/charts/kserve-runtime-configs \
  --version v0.21.0 -n kserve --set kserve.version=v0.21.0 \
  --set kserve.servingruntime.enabled=false --set kserve.llmisvcConfigs.enabled=true --wait

# Envoy Gateway (step 7) with InferencePool backends: Agent Router hands a
# self-hosted model's requests to its server's endpoint picker.
helm upgrade -i eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.9.2 -n envoy-gateway-system \
  -f agent-router/envoy-gateway-values.yaml -f agent-router/envoy-gateway-values-inferencepool.yaml
kubectl -n envoy-gateway-system rollout status deploy/envoy-gateway --timeout=5m
```

Verify:

```sh
kubectl get crd llminferenceservices.serving.kserve.io inferencepools.inference.networking.k8s.io
kubectl get llminferenceserviceconfigs -n kserve | grep config-llm-scheduler   # the presets
kubectl get location <name> -o jsonpath='{.status.operators.kserve}'           # on the control plane: true
```

The GPUs are the cluster's: the NVIDIA (or AMD) GPU Operator and its device
plugin, so nodes offer `nvidia.com/gpu` (`ModelServer` `spec.resources.gpuResource`
for another). Taint GPU nodes and give the servers tolerations
(`spec.scheduling`) to keep other workloads off them. Without GPUs, small models
run on vLLM's CPU image (`gpus: 0`).

The platform leaves KServe's TLS between gateway and server off (the
default: `enableLLMInferenceServiceTLS` in KServe's `inferenceservice-config`):
servers are reached in the Project's namespace only, through its gateway.

## 9. Platform settings: `project-defaults` (after `api/`)

[`control-plane/project-defaults.yaml`](control-plane/project-defaults.yaml)
is the `EnvironmentConfig` every Project's composition reads: one per control
plane, for all Projects, so it goes in before the first one (its CRD comes
with Crossplane, so after `api/install/install.sh`). It holds this
environment's values:

- the Grafana ingress host (`grafana-<project>.paas.cndev.nl`) and the
  remote-write endpoint the locations' Prometheus send to
  (`prometheus-<project>.paas.cndev.nl`), both through the HAProxy Ingress of
  step 5. A wildcard DNS record `*.paas.cndev.nl` points at its LoadBalancer
  IP; use your own domain (or `<x>-{project}.<ip>.nip.io` without DNS)
  elsewhere
- where kube-prometheus-stack's ServiceMonitors live in the locations (step 2)
- the COSI driver and access class for each Project's backup bucket
  ([`cosi/`](cosi/README.md)); leave `backup` out without COSI, and clusters
  bring a backup store of their own

[`api/examples/project-defaults.yaml`](../api/examples/project-defaults.yaml)
documents every key. Projects pick up a change on their next reconcile.

```sh
kubectl apply -f control-plane/project-defaults.yaml
```

## 10. The `demo` Project (after `api/`)

On the control plane, after `api/install/install.sh`, step 9, and registering the location the
demo workloads run in (`api/install/add-location.sh`). [`demo/project.yaml`](demo/project.yaml)
names that location `si-ske-demo`: change it to yours. Crossplane then creates the `demo`
namespace on the control plane and in the location, a Prometheus in the location that writes to
the Project's Prometheus on the control plane, and a Grafana there. See
[Projects](../portal/catalog/docs/platform/projects.md).

```sh
kubectl apply -f demo/project.yaml
kubectl wait project/demo --for=condition=Ready --timeout=10m
```

Verify:

```sh
kubectl get project demo                # GRAFANA column: the ingress URL
kubectl -n demo get prometheus,grafana,grafanadatasource,grafanadashboard
KUBECONFIG=<location> kubectl -n demo port-forward svc/prometheus-operated 9090   # in the location: Status > Targets: CNPG pods, kubelet, kube-state-metrics up
kubectl -n demo get secret grafana-admin-credentials -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d; echo
```

More projects are one object each: `kubectl apply` a Project, or use
**New project** in the portal.

> Deletion protection is on by default: `kubectl delete namespace demo` and `kubectl delete project demo`
> are refused until you set `spec.deletionProtection: false`.
