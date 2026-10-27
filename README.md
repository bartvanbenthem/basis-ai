# BASIS
<strong>Build AI Services In Sovereign infrastructure</strong>

<p align="center">
  <img src="portal/logos/basis-icon.svg" alt="BASIS logo" width="160">
</p>

BASIS is a Platform as a Service on Kubernetes for the platform side of generative AI services and
agents, on infrastructure you own. The model can be anyone's (Claude, GPT, Mistral or one you serve
yourself). The data and its retrieval, the caches, the gateway that holds the provider keys, and the
audit trail stay with you. Teams, or their agents, order what they need through a Kubernetes API, a
developer portal or MCP tools, and the platform runs it. Built on [Crossplane](https://www.crossplane.io/)
and [Backstage](https://backstage.io/).

## What teams get

| API | What |
|---|---|
| `GenAIStack` | A RAG database, a cache and a model gateway for one AI service, wired together, with one connection Secret for the app and an optional warm standby in a second site. [Guide](portal/catalog/docs/ai/genai-stacks.md) |
| `ModelGateway` | An OpenAI-compatible endpoint ([Agent Router](https://github.com/theagentrouter/agent-router) on [Envoy Gateway](https://gateway.envoyproxy.io)) to hosted and self-hosted models: provider keys kept in the platform, a key per client, retries and fallbacks, token caps, an audit log per call. [Guide](portal/catalog/docs/ai/model-gateways.md) |
| `ModelServer` | An open model on your GPUs: [vLLM](https://docs.vllm.ai/) on [KServe](https://kserve.github.io/website/), with [llm-d](https://llm-d.ai/)'s prefix-cache-aware routing. [Guide](portal/catalog/docs/ai/model-servers.md) |
| `MCPServer` | A Project's knowledge base (hybrid search) and its agents' memory as MCP tools ([basis-mcp](mcp/)), a key and a set of tools per agent. [Guide](portal/catalog/docs/ai/mcp-servers.md) |
| `PostgresCluster` | A highly available PostgreSQL on [CloudNativePG](https://cloudnative-pg.io/): CPU and memory with PostgreSQL tuned to them, PgBouncer, pgvector and other extensions, backups, point-in-time restore, geo replication. [Guide](portal/catalog/docs/clusters/create.md) |
| `ValkeyCache` | An exact or semantic (vector) cache on [Valkey](https://valkey.io/). [Guide](portal/catalog/docs/caches/valkey.md) |
| `Project` | A team's namespace in every site, with its own Prometheus and Grafana, access control, quota, backup bucket, deletion protection, and governance: data classification, budget and cost forecast, allowed models. [Guide](portal/catalog/docs/platform/projects.md) |

Every workload comes with metrics, alerts and a Grafana dashboard in its Project.

```yaml
apiVersion: ai.cndev.nl/v1alpha1
kind: GenAIStack
metadata:
  name: support-bot
  namespace: demo
spec:
  retrieval:
    cpu: "1"
    memory: 4Gi
    extensions: [vector]
  cache:
    mode: semantic
  gateway:
    models:
      - name: gpt-4o-mini
        endpoint: https://api.openai.com/v1
        apiKeySecretRef:
          name: openai
```

See [`api/examples/`](api/examples/) for every API, and the platform docs in
[`portal/catalog/docs/`](portal/catalog/docs/index.md) (also in the portal under **Docs**).

## Architecture

- A **control plane** cluster runs Crossplane, the APIs and the portal, but no workloads.
- Workloads run in **locations**: other Kubernetes clusters registered with the platform, in any
  region or data center.
- A **Project** has a **protected** location and optionally a **recovery** location. With geo
  replication, a database keeps a replica in the recovery location, fed from the Project's backup
  bucket. A switchover moves the primary there without losing data; a failover promotes it when the
  protected location is down. See [Disaster recovery](portal/catalog/docs/clusters/disaster-recovery.md).

| Folder | What |
|---|---|
| [`api/`](api/README.md) | The APIs (Crossplane v2) and function-basis, the Go composition function behind all of them |
| [`deps/`](deps/README.md) | The operators the platform builds on, and how to install them |
| [`portal/`](portal/README.md) | The Backstage portal: forms, catalog, MCP tools for agents, and the platform docs |
| [`mcp/`](mcp/README.md) | basis-mcp, the server every `MCPServer` runs |
| [`hack/`](hack/README.md) | End-to-end tests and operator scripts |

## Install

1. **Every location:** the operators for what runs there ([`deps/`](deps/README.md)): cert-manager,
   the Prometheus Operator, CloudNativePG (`KUBECONFIG=dc-a.kubeconfig deps/cnpg/install.sh`), and
   the Valkey operator, Envoy Gateway + Agent Router or KServe for caches, gateways or self-hosted
   models.
2. **The control plane:** the Prometheus Operator and grafana-operator ([`deps/`](deps/README.md)),
   then the platform:

   ```sh
   api/install/install.sh                                      # Crossplane, function-basis, the APIs
   api/install/add-location.sh dc-a dc-a.kubeconfig            # each location (or add it in the portal)
   kubectl apply -f deps/control-plane/project-defaults.yaml   # platform-wide Project settings (edit the domain)
   kubectl apply -f deps/demo/project.yaml                     # Project demo (edit its location)
   kubectl apply -f api/examples/minimal.yaml                  # a PostgresCluster in demo
   ```

3. **The portal**, on the control plane: [`portal/README.md`](portal/README.md).

The full walkthrough is [Install](portal/catalog/docs/platform/install.md).

### Update function-basis

`install.sh` installs the composition function, function-basis, from ghcr.io at the tag in
[`api/install/function-basis.yaml`](api/install/function-basis.yaml). Whenever `api/function/`
changes, publish a new version and roll it out before applying the APIs that need it:

```sh
make -C api test                                      # unit + render tests
make -C api function-push FUNCTION_VERSION=<version>  # publish to ghcr.io
# set <version> in api/install/function-basis.yaml and as FUNCTION_VERSION in api/Makefile, commit
kubectl apply -f api/install/function-basis.yaml      # on every control plane (or api/install/install.sh)
```

`MCPServer`s run basis-mcp's image, at the tag in `DefaultImage` in
`api/function/mcpserver/compose.go`. When [`mcp/`](mcp/) changes, publish it first, then function-basis:

```sh
make -C mcp test-db
make -C mcp push VERSION=<version>   # then set <version> in mcp/Makefile and DefaultImage, and publish function-basis
```

See [Releasing function-basis](api/README.md#releasing-function-basis) for logging in to ghcr.io,
the package's visibility, and rolling back.

## Test

| Command | Needs | Covers |
|---|---|---|
| `make -C api test` | Go, crossplane CLI, Docker/podman | function-basis's unit tests; every API rendered from `api/tests/render`, validated against the real CRDs, and asserted on |
| `make -C mcp test-db` | Rust, podman | basis-mcp, including the store against PostgreSQL with pgvector |
| `cd portal && yarn tsc && yarn test:all` | node 22 | the portal's backend and frontend |
| `deps/cnpg/verify.sh` | helm | the vendored CNPG charts lint and render |
| `hack/e2e-kind.sh` | kind, helm, Docker/podman | a control plane and one location on kind: a Project, a PostgresCluster and a ValkeyCache end to end |
| `hack/e2e-locations.sh` | kind, helm, Docker/podman | a protected and a recovery location: geo replication, point-in-time restore, switchover |

The e2e scripts use their own kubeconfigs in `.e2e/` and need `fs.inotify.max_user_instances` ≥ 512.

## Roadmap

- **Governance for agents:** PII redaction and guardrail models at the gateway, an external endpoint
  for MCP servers, OpenTelemetry traces of agent runs. See [Platform scope](portal/catalog/docs/scope.md).
- **Automatic major upgrades:** opt-in in-place `pg_upgrade` in a maintenance window.
- **Self-fencing at each site:** a lease per site, so a failover never leaves two primaries.
- **Maintenance windows:** when rollouts, restarts and upgrades may run, per cluster or Project.
