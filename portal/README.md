# portal/: BASIS portal

A Backstage app (1.55, new frontend system) to create and inspect everything from [`api`](../api):
GenAI stacks, MCP servers, model gateways, model servers, PostgreSQL clusters, Valkey caches,
Projects and Locations. It runs on the control plane next to Crossplane, reads the locations through
their kubeconfigs, serves the platform as MCP tools for agents, and hosts the platform docs.

| Section | Pages (under `/basis`) |
|---|---|
| AI services | GenAI stacks (create, edit, switch the active site, connection values), MCP servers (clients, keys, **Connect an agent**) |
| Building blocks | Model gateways (models, clients and keys), model servers, PostgreSQL (create, edit, **Disaster recovery**, **Backups** and restore, logs, monitoring), Valkey caches |
| Platform | Projects, Locations (add with a kubeconfig, health checks), Volumes and Buckets (find and delete orphans), Audit logs (events, pgaudit, gateway and MCP calls) |
| Docs | Platform docs (TechDocs, [`catalog/docs`](catalog/docs/index.md)) and the API reference |

Every create and edit form shows the manifest or the exact change and can **Validate** it (a
server-side dry run). The backend writes only the APIs' objects, with field manager
`backstage-basis`: server-side apply to create, a JSON merge patch of the changed fields to edit,
so changes made with kubectl stay. Validation lives in one place, the XRDs, and their errors show in
the form as-is. Every Project, cluster, cache, gateway and stack is also in the catalog as a
`Resource`, and there are Software Templates for them in `templates/`.

```
plugins/basis            frontend plugin: pages, entity tabs, API client
plugins/basis-backend    REST API /api/basis, catalog provider, scaffolder actions, MCP actions
plugins/basis-common     shared types and permissions
templates/               Software Templates
catalog/                 the platform docs (MkDocs) and the API reference (generated from the XRDs: make -C ../api generate)
deploy/                  control-plane manifests: RBAC, Backstage's own database, Deployment
```

## Run locally

```sh
yarn install
python3 -m venv .techdocs-venv && .techdocs-venv/bin/pip install mkdocs-techdocs-core==1.6.1   # once, for the docs
PATH=$PWD/.techdocs-venv/bin:$PATH BASIS_KUBE_CONTEXT=$(kubectl config current-context) \
  BASIS_BUCKETS_ENDPOINT=https://s3.example.com yarn start
# http://localhost:3000 → Enter as guest
```

| Setting | What |
|---|---|
| `BASIS_KUBE_CONTEXT` | The control plane's context (default: your current one) |
| `BASIS_BUCKETS_ENDPOINT` | The COSI driver's S3 endpoint, for the Buckets page |
| `BASIS_GRAFANA_URL` | Fallback Grafana for clusters outside a Project (`{namespace}` is replaced); a Project's own Grafana is used otherwise |

Other settings are under `basis:` in `app-config.yaml` (schema: `plugins/basis-backend/config.d.ts`).
Without MkDocs on the `PATH`, everything but the platform docs works. Check the docs with
`cd catalog && ../.techdocs-venv/bin/mkdocs build --strict -d /tmp/site`.

## Test

```sh
yarn tsc && yarn test:all && yarn lint:all
```

## Deploy

```sh
yarn install --immutable && yarn tsc && yarn build:backend
docker build -t <registry>/basis-portal:<tag> -f packages/backend/Dockerfile .
# set the image and BASIS_BUCKETS_ENDPOINT in deploy/backstage.yaml, then on the control plane:
kubectl apply -k deploy/
```

- **Access:** [`deploy/rbac.yaml`](deploy/rbac.yaml) gives the backend the APIs' objects, read access to
  namespaces, and Secrets only in `basis-locations` (the locations' kubeconfigs) plus the COSI
  driver's Secret. Pods, logs and events are read in the locations with their kubeconfigs.
- **Database:** Backstage's own database is a plain CloudNativePG `Cluster`
  ([`deploy/database.yaml`](deploy/database.yaml)), so install [`deps/cnpg`](../deps/cnpg) on the
  control plane too.
- **Before production:** replace the guest sign-in with your IdP
  ([Backstage auth](https://backstage.io/docs/auth/)) and the allow-all permission policy with one
  that restricts the `basis.*` permissions below. Adding a location means handing over a kubeconfig,
  so keep `basis.location.*` to platform admins.

## Locations

A location is a `Location` object plus a Secret in `basis-locations` holding its kubeconfig (key
`kubeconfig`, label `platform.cndev.nl/location=true`). The kubeconfig never leaves the backend. On
upload the backend keeps only the chosen context and rejects kubeconfigs that would run commands or
read files (`exec`, `auth-provider`, `token-file`, certificate file paths) and plain-HTTP servers.
For EKS, GKE or AKS, which use `exec`, use a ServiceAccount token instead:

```sh
kubectl -n kube-system create serviceaccount basis-platform
kubectl create clusterrolebinding basis-platform --clusterrole=cluster-admin --serviceaccount=kube-system:basis-platform   # or a narrower role
kubectl -n kube-system create token basis-platform --duration=8760h   # paste as users[].user.token
```

The health checks run from the backend, so a location must be reachable from where the portal
runs. A location can't be removed while a Project uses it.

## Permissions

`basis.<resource>.{read,create,update,delete}` for `project`, `location`, `cluster`, `cache`,
`stack`, `gateway`, `server` and `mcp`, plus:

| Permission | Allows |
|---|---|
| `basis.cluster.{restore,switchover,failover}` | Restoring a cluster, and moving a cluster's or stack's primary site |
| `basis.project.audit.read` | The audit logs (they contain SQL statements) |
| `basis.{cache,stack,gateway,mcp}.credentials.read` | Reading a cache's password, a stack's connection values, or client keys |
| `basis.{bucket,volume}.{read,delete}` | The Buckets and Volumes pages, deleting orphans |

The UI hides what the user isn't allowed to do.

## MCP tools for agents

`@backstage/plugin-mcp-actions-backend` serves these actions as MCP tools at
`<backend>/api/mcp-actions/v1` ([`actions.ts`](plugins/basis-backend/src/actions.ts)), each checked
against the caller's `basis.*` permissions. None returns credentials.

| Action | What |
|---|---|
| `basis:list-projects` | Projects and their locations |
| `basis:list-genai-stacks`, `basis:list-model-gateways`, `basis:list-model-servers`, `basis:list-mcp-servers` | What exists, with health, endpoints and Secrets |
| `basis:create-genai-stack`, `basis:create-model-gateway`, `basis:create-mcp-server` | Validate (`dryRun`, the default) or create |

See [Agents](catalog/docs/ai/agents.md) for users, and Backstage's
[MCP actions](https://backstage.io/docs/ai/mcp-actions) for authentication.
