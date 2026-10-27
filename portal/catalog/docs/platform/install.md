# Install

Everything installs from the repository: charts are vendored, versions pinned. Do the steps in this
order; each says where it runs.

## 1. Dependencies

| Component | Control plane | Every location |
|---|---|---|
| cert-manager | only for the portal's database | yes (Barman Cloud plugin) |
| Prometheus Operator (kube-prometheus-stack, its own Prometheus off) | yes | yes |
| grafana-operator | yes | – |
| Ingress controller (e.g. HAProxy) | yes: Grafana and the remote-write endpoint | – |
| Valkey operator | – | only where caches (and stacks) run |
| Envoy Gateway + Agent Router | – | only where model gateways (and stacks) run |
| KServe (LLMInferenceService, with llm-d's scheduler) and GPU nodes | – | only where model servers run |
| ClusterIssuer `basis` (cert-manager) and LoadBalancer Services | – | only where gateways are exposed (`spec.expose`) |

The exact commands are in `deps/README.md`.

## 2. CloudNativePG, in every location (from `deps/cnpg`)

```sh
KUBECONFIG=dc-a.kubeconfig deps/cnpg/install.sh   # CNPG 1.30, Barman Cloud plugin, image catalogs
```

Two operator replicas; the webhooks fail closed, so don't run it with one. Check that the location
supports image volumes if you offer the Vector & RAG profile (Kubernetes `ImageVolume`, containerd 2.1
or later); the portal's location health shows it.

## 3. The APIs, on the control plane

```sh
api/install/install.sh      # Crossplane 2.4, function-basis, provider-kubernetes, RBAC, XRDs,
                            # Compositions, policies, and the extension catalog (once)
```

`install.sh` installs the published function-basis package (every API's composition) and waits until it's Healthy. The
package must be public, or Crossplane needs a pull secret (see [Upgrades](upgrades.md)).

## 4. Locations

```sh
api/install/add-location.sh dc-a dc-a.kubeconfig    # or: portal → Locations → Add location
kubectl get locations -o wide                        # CONNECTED and READY
```

See [Locations](locations.md).

## 5. Platform settings

`deps/control-plane/project-defaults.yaml` is the EnvironmentConfig every Project reads: the Grafana
and remote-write ingress hosts (a wildcard DNS record on the ingress controller's address), where
kube-prometheus-stack runs in the locations, and the COSI driver and access class for backup buckets.

```sh
kubectl apply -f deps/control-plane/project-defaults.yaml   # edit the hosts first
```

## 6. Backup buckets (optional)

With COSI on the control plane, every Project gets a backup bucket of its own (`deps/cosi/`). Without
it, leave `backup` out of `project-defaults`; clusters then bring a backup store of their own.

## 7. The portal

```sh
cd portal
yarn install --immutable && yarn tsc && yarn build:backend
docker build -t <registry>/basis-portal:<tag> -f packages/backend/Dockerfile .
kubectl apply -k deploy/      # with the image set in deploy/backstage.yaml
```

Its own database is a CNPG Cluster on the control plane, so install `deps/cnpg/` there too. Before
production, replace the guest login with your IdP and the allow-all permission policy with one that
limits `basis.location.*` to platform admins (a location holds a cluster-admin kubeconfig).

## 8. Check

```sh
kubectl apply -f deps/demo/project.yaml        # a Project (edit its location)
kubectl apply -f api/examples/minimal.yaml     # a PostgresCluster in it
kubectl get project,postgrescluster -A         # both READY
kubectl apply -f api/examples/valkeycache.yaml # a semantic cache (needs the Valkey operator there)
kubectl get valkeycache -A                     # STATE Ready
kubectl apply -f api/examples/genaistack.yaml  # a GenAI stack (Valkey operator + Agent Router there)
kubectl get genaistack -A                      # READY
```

`hack/e2e-kind.sh` and `hack/e2e-locations.sh` run the whole install on kind, including replication,
restore and switchover.
