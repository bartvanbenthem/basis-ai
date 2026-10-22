# Locations

A **location** is a Kubernetes cluster the platform runs workloads in: databases, caches, gateways. The control plane itself runs
none. Each Project uses one location as its protected site and optionally another as its recovery
site.

## Add a location

1. Install the operators in it (CloudNativePG, the Barman Cloud plugin, the image catalogs):

    ```sh
    KUBECONFIG=dc-a.kubeconfig deps/cnpg/install.sh
    ```

2. Register it, in the portal (**Locations → Add location**) or on the control plane:

    ```sh
    api/install/add-location.sh dc-a dc-a.kubeconfig
    kubectl get locations -o wide
    ```

The kubeconfig is stored as a Secret in `basis-locations` on the control plane. It must work from
inside the control plane (a token or client certificate, no exec plugin), and its identity needs
cluster-admin or an equivalent role. The Location is `READY` once Crossplane reaches it and both
operators (CloudNativePG, Prometheus Operator) are installed.

```yaml
apiVersion: platform.cndev.nl/v1alpha1
kind: Location
metadata:
  name: dc-a
spec:
  displayName: EU01
  environment: production
  provider: ske
  region: Germany South 1
  schedulable: true          # false: no new databases here
  credentials:
    secretRef: {namespace: basis-locations, name: dc-a}
```

## Health

The portal checks every location from its backend; **Check now** on a location's page runs the checks
again.

| Check | Fails when |
|---|---|
| API server | `/version` doesn't answer or the credentials are refused: the location is **Unreachable** |
| Readiness | `/readyz` reports not ready |
| Nodes | No node is Ready (**Degraded**); some aren't (a warning) |
| CloudNativePG | The operator isn't installed (a warning) |
| Valkey operator | Never fails: says whether the operator is installed, which only [Valkey caches](../caches/valkey.md) need |
| Agent Router | Never fails: says whether Agent Router (Envoy Gateway) is installed, which only [model gateways](../ai/model-gateways.md) need |
| KServe | Never fails: says whether KServe's LLMInferenceService controller is installed, which only [model servers](../ai/model-servers.md) need |
| Image volumes | The API server drops image volumes (`ImageVolume` feature gate), or a node's runtime is older than containerd 2.1 / CRI-O 1.31 (a warning). Needed for extensions mounted from images, such as those of the [Vector & RAG](../clusters/vector-rag.md) profile |

`add-location.sh` runs the same checks when it registers a location.

## Remove a location

Removing a location is refused while a Project uses it. Removing it deletes the Location and its
Secret on the control plane; nothing changes on the cluster itself.
