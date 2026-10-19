# Dependencies

Everything the platform needs before
[`operator/`](../operator/) and
[`api/`](../api/) are installed, the platform-wide
Project settings (`control-plane/project-defaults.yaml`), plus the
`demo` Project (a namespace with its own Prometheus and Grafana). The
platform has a **control plane** (Crossplane, the APIs, the portal, each
Project's Grafana; no databases) and **locations**, the clusters the
databases run in. Each component goes where its column says.

| Component | Needed for | Control plane | Locations |
|---|---|---|---|
| cert-manager | barman-cloud backup plugin | only for the portal's own database | yes, unless `INSTALL_BARMAN=false` |
| Prometheus Operator | `Prometheus` per Project; `PodMonitor` / `PrometheusRule` per PostgresCluster | yes (the Prometheus the locations write to) | yes |
| grafana-operator | `Grafana` per Project, `GrafanaDashboard` per PostgresCluster | yes | no |
| HAProxy Ingress | Grafana from outside, and the remote-write endpoint the locations' Prometheus send to | yes | no |

Install them in the order below, each in the clusters its row says.

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

## 3. grafana-operator

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

## 4. HAProxy Ingress (optional)

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

## 5. Platform settings: `project-defaults` (after `api/`)

[`control-plane/project-defaults.yaml`](control-plane/project-defaults.yaml)
is the `EnvironmentConfig` every Project's composition reads: one per control
plane, for all Projects, so it goes in before the first one (its CRD comes
with Crossplane, so after `api/install/install.sh`). It holds this
environment's values:

- the Grafana ingress host (`grafana-<project>.paas.cndev.nl`) and the
  remote-write endpoint the locations' Prometheus send to
  (`prometheus-<project>.paas.cndev.nl`), both through the HAProxy Ingress of
  step 4. A wildcard DNS record `*.paas.cndev.nl` points at its LoadBalancer
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

## 6. The `demo` Project (after `api/`)

A namespace with its own Prometheus and Grafana is a **Project**
(`platform.cndev.nl/v1alpha1`, see
[`api`](../api/README.md#the-project-api)), so
this step runs on the control plane *after* `api/install/install.sh`
and after registering the location the demo databases run in
(`api/install/add-location.sh`, with `operator/install.sh`
run against that location first). `demo/project.yaml` names it
`si-ske-demo`: change that to your location's name.

It needs the platform settings of step 5.
[`demo/project.yaml`](demo/project.yaml) is the `demo` Project. Crossplane
creates the namespace on the control plane and in the location, a Prometheus
in the location that scrapes every `PodMonitor` and `PrometheusRule` in it
(plus the kubelet / kube-state-metrics / node-exporter targets from step 2)
and writes to the project's Prometheus on the control plane, and there a
Grafana with a `prometheus` datasource, anonymous Viewer access and
embedding allowed. The Grafana carries `dashboards.paas.cndev.nl/scope=demo`,
which every PostgresCluster's `GrafanaDashboard` in `demo` selects.

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

More projects are one object each (`kubectl apply` a Project, or use
**New project** in the portal). The portal takes each cluster's Grafana from
its Project's `status.grafana.url`, so `CNPG_GRAFANA_URL` is only a fallback
for clusters outside a Project.

### Migrating a `demo` namespace set up with the old manifests

Before this change, `demo/prometheus.yaml` and `demo/grafana.yaml` created
the same objects by hand. The Project composes objects with the same names
(`Prometheus prometheus`, `Grafana grafana`, `GrafanaDatasource prometheus`,
`ServiceAccount prometheus`), so try it on a non-production cluster first and
check that Crossplane took them over
(`kubectl -n demo get prometheus prometheus -o jsonpath='{.metadata.ownerReferences}'`
should name `Project demo`). Then remove the old cluster-wide RBAC, which the
Project replaces with `ClusterRoleBinding platform:project:demo:prometheus`:

```sh
kubectl delete clusterrolebinding demo-prometheus
kubectl delete clusterrole demo-prometheus
```

The old Grafana also answered on `grafana.paas.cndev.nl`. A Project has one
host from `hostTemplate`, so add that DNS name elsewhere if you still need it.

> The `demo` namespace now belongs to the Project. Deletion protection is on
> by default: `kubectl delete namespace demo` and `kubectl delete project demo`
> are refused until you set `spec.deletionProtection: false`.
