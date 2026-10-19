# portal/: CNPG portal

A Backstage app (1.55, new frontend system) for creating Projects and deploying and viewing every
`PostgresCluster` from [`api`](../api). It runs on the platform's
control plane, next to Crossplane; the databases run in the locations, which it reads through
their kubeconfigs. It is a CNPG-only portal in Tuskpilot
style: a dark theme, the Tuskpilot logo, and a fixed sidebar with Locations, Add location, Projects, New
project, Volumes, Buckets, Audit logs, PostgreSQL and New cluster.

| Feature | Where |
|---|---|
| **PostgreSQL** page (the landing page): summary tiles, then all clusters across namespaces with health, version, instances and size, primary, location (and its replica cluster), pooler/backup flags; filter + search; auto-refresh | `plugins/cnpg` (`/cnpg`) |
| **New cluster**: project, owner, a **size** from the platform's catalog (XS–XL: CPU and memory per instance plus tuned PostgreSQL settings, and suggested volumes) or custom CPU and memory, storage, HA, pooler, backups, geo replication, monitoring and audit logging (pgaudit); the panel shows the manifest, **Validate** dry-runs it. Backend: `GET /sizes` (the `postgres-sizes` catalog, empty without one: the form then offers custom resources only) | `/cnpg/create` |
| **New RAG cluster**: the create form with the **Vector & RAG** workload profile preset (also picked in the form itself): size M, PostgreSQL 18 and pgvector, VectorChord and pg_search from the extension catalog (mounted from images); extensions that need PostgreSQL 18 can't be ticked on an older version | `/cnpg/create?profile=vector` |
| Cluster detail: status, connection endpoints & credential Secret, size, the CPU/memory and PostgreSQL settings it runs with, storage/HA/pooler/backup/monitoring config, both sites with their location and role (primary, replica, promoting), instance pods and recent events from both, conditions, **Edit**, delete (type-to-confirm) | `/cnpg/:namespace/:name` |
| **Edit cluster**: everything that changes in place: volume sizes (grow only), instances, size (or custom CPU/memory), HA, pooler, backups, monitoring, audit logging (switching pgaudit on or off restarts the instances one by one; only `pgaudit.log` is patched, other PostgreSQL parameters stay), owner and **geo replication**. Name, project, protected location, primary site, PostgreSQL version, database and StorageClass are read-only. The panel shows the exact change (a merge patch); **Validate** dry-runs it | `/cnpg/:namespace/:name/edit` |
| **Disaster recovery** tab (geo-replicated clusters): both sites with their location, role (primary, replica cluster, promoting), health and instances; the WAL archive the replica cluster replays; **Switch over** (planned, demotes the primary first, loses nothing) and **Fail over** (promotes the other site right away; type-to-confirm, warns when the primary's site still looks healthy) to the other site, and back. A switchover that waits for a site that is down can be escalated to a failover. Backend: `POST /clusters/:namespace/:name/promote` with `{site, mode}`; edits can't move the primary | `/cnpg/:namespace/:name/dr` |
| **Backups** tab: where the cluster archives (store and folder), schedule, retention, last base backup and the recoverable window; **Restore to a new cluster** up to a point in time or the latest state (new name, storage size; the target time is checked against the window). The source is never touched: restoring is creating a new cluster with `spec.restore`. Backend: `POST /projects/:name/restore` with `{name, from: {cluster} \| {serverName}, targetTime?, storageSize?}` | `/cnpg/:namespace/:name/backups` |
| **Locations** page: the Kubernetes clusters the platform can use, with environment, provider/region, API server, Kubernetes version, Ready nodes, health (probed from the backend, cached 30s), whether Crossplane can use it and how many projects do | `/cnpg/locations` |
| Location detail: settings, connection (server, context, auth type, TLS), what Crossplane reports (connected, operators installed) and projects, every health check, **Check now**, **Edit**, remove (type-to-confirm, refused while a project lists it) | `/cnpg/locations/:name` |
| **Add location** / **Edit location**: upload or paste a kubeconfig (pick a context if it has several), name, environment, provider, region, owner, default StorageClass, open/closed for new databases; **Test connection** probes it before saving | `/cnpg/locations/create`, `/cnpg/locations/:name/edit` |
| **Logs** tab: stdout of the cluster's pods in any of its locations (pick a pod, tail size, follow, previous container), shown readable or as raw JSON | `/cnpg/:namespace/:name/logs` |
| **Monitoring** tab: the cluster's CNPG Grafana dashboard (the `GrafanaDashboard` the composition creates), embedded with a time-range picker and an "Open in Grafana" link | `/cnpg/:namespace/:name/monitoring` |
| **Projects** page: every Project (namespace + Prometheus + Grafana) with health, owner, cluster count and a Grafana link | `/cnpg/projects` |
| Project detail: namespace, owner, protected and recovery location (each with its readiness), backup bucket and whether each location reaches it (with the failed check's log), its **backup folders** (the Project's inventory, including clusters deleted since, each with **Restore**), access, quota, deletion protection, Grafana/Prometheus endpoints (and where the locations write their metrics), the clusters in it, **Edit**, **Create cluster here**, **Delete** (once it has no clusters left; type-to-confirm) | `/cnpg/projects/:name` |
| **Edit project**: owner, description, adding a recovery location, access groups, quota, metrics retention, Prometheus volume size (grow only), Grafana ingress. The locations are read-only once set | `/cnpg/projects/:name/edit` |
| **Buckets** page: every bucket on the object store account COSI provisions with (the COSI driver's keys), also those nothing uses any more: **In use** (a Project's backup bucket), **COSI claim** (a BucketClaim outside a project) or **Orphaned** (e.g. the retained bucket of a deleted project, named after it); objects, size, last write; summary tiles and a filter. Sizes come from listing the objects (up to 100,000 per bucket, cached a minute) | `/cnpg/buckets` |
| Bucket detail: what uses it, endpoint, usage, its **folders** (per backup server under `barman/`, with the cluster from the project's inventory), **Delete** for an orphaned bucket only (type-to-confirm; empties it, all versions and unfinished uploads, then deletes it). Backend: `GET /buckets`, `GET /buckets/:name`, `DELETE /buckets/:name` (409 for one in use) | `/cnpg/buckets/:name` |
| **Volumes** page: the disks of PostgreSQL instances: CNPG's PersistentVolumeClaims in each project's namespace, in every location the project uses (read with that location's kubeconfig), with the PersistentVolume behind each: **In use** (its PostgresCluster still runs there, or a pod mounts it), **Orphaned** (a claim of a cluster that no longer runs there) or **Released** (a volume with reclaim policy Retain whose CNPG claim is gone); cluster, instance and role (data/WAL/tablespace), size (and a resize in progress), used space from the node's kubelet (`nodes/proxy` `stats/summary`, cached a minute), storage class and reclaim policy; summary tiles, filters on state, project (`?project=`, linked from the project page) and location; an unreachable location is shown as a warning. **Delete** for orphaned and released volumes only (type-to-confirm): a Retain volume is switched to Delete first, so the disk goes too. Backend: `GET /volumes[?project=]`, `DELETE /volumes/:location/claims/:namespace/:name`, `DELETE /volumes/:location/persistentvolumes/:name` (409 for one in use; the state is re-checked server-side) | `/cnpg/volumes` |
| **Audit logs** page, per project (`?project=`, linked from the project page): the Kubernetes events of the project's namespace on the control plane (Project, PostgresCluster XRs, Crossplane) and in every location it uses (CNPG Clusters, pods, volumes, backups), and the **pgaudit** records of its PostgreSQL clusters (who ran which statement, on which object, from where), newest first; summary tiles, filters on location, cluster, source and warnings, search, **Export JSON**. Kubernetes keeps events for about an hour; audit records come from each instance's current log (`tailLines`, default 5000), so keep a longer history in a log store. A cluster records SQL once **Audit logging (pgaudit)** is on in its create or edit form, which sets `spec.postgresql.parameters["pgaudit.log"]` (schema and permission changes, plus data changes, or every statement); the page lists the clusters without it. Backend: `GET /projects/:name/audit[?tailLines=]` | `/cnpg/audit` |
| Create-project form with the protected and (optional) recovery location picked from the registered locations, manifest preview and **Validate** | `/cnpg/projects/create` |
| Create-cluster form with live manifest preview and **Validate** (server-side dry run against the XRD). The cluster's namespace is picked from the Projects, not typed; it runs in that project's protected location, and **Geo replication** (offered when the project has a recovery location) adds a replica cluster there. Backups go to the project's COSI bucket by default when it has one, or to a destination of your own | `/cnpg/create` |
| Every Project in the catalog as a `Resource` of type `project` (named after the project, owner from `spec.owner`), and every PostgresCluster as a `Resource` of type `postgres-cluster` (owner/system from the `backstage.io/owner` / `backstage.io/system` labels, `dependsOn` its project, a **PostgreSQL** tab) | `plugins/cnpg-backend` catalog module |
| Software Templates *Project* (action `cnpg:project:create`) and *PostgreSQL cluster (CloudNativePG)* (action `cnpg:postgrescluster:create`, project picked with an `EntityPicker` on `spec.type: project`) | `templates/` |
| Permissions `cnpg.cluster.{read,create,update,delete,restore,switchover,failover}` (`restore` also needs `create`, and guards a plain create with `spec.restore` too), `cnpg.project.{read,create,update,delete}`, `cnpg.project.audit.read` (the audit logs, which carry SQL statements; also needs `cnpg.project.read`), `cnpg.location.{read,create,update,delete}` `cnpg.bucket.{read,delete}` and `cnpg.volume.{read,delete}`; the UI hides create/edit/delete when denied | `plugins/cnpg-common` |

```
plugins/cnpg            frontend plugin (pages, entity tab, API client)
plugins/cnpg-backend    REST API /api/cnpg, catalog entity provider, scaffolder action
plugins/cnpg-common     shared types + permissions
templates/              Software Templates (project, postgres-cluster)
deploy/                 control-plane manifests: RBAC, Backstage's own DB (a CNPG Cluster), Deployment
```

The backend writes **only** `PostgresCluster`, `Project` and `Location` objects with field manager `backstage-cnpg`
(plus the locations' kubeconfig Secrets in `cnpg-locations`, see [Locations](#locations); the Buckets page
reads the COSI driver's Secret and deletes orphaned buckets on the object store, see `cnpg.buckets` in `app-config.yaml`):
server-side apply to create them, a JSON merge patch of just the changed fields to edit them (so settings
made with kubectl stay). Validation stays in one place, the XRD: API server errors such as
"synchronousReplicas must be lower than instances" or "volumes can grow but not shrink" are shown in the
form as-is.

## Run locally

```sh
yarn install
# MkDocs for the platform docs (TechDocs), once; .techdocs-venv is git-ignored
python3 -m venv .techdocs-venv && .techdocs-venv/bin/pip install mkdocs-techdocs-core==1.6.1

PATH=$PWD/.techdocs-venv/bin:$PATH CNPG_KUBE_CONTEXT=$(kubectl config current-context) yarn start
# http://localhost:3000 → Enter as guest
```

Without MkDocs on the `PATH` everything works but **Docs → Platform docs**, which then can't be built.
If `python3 -m venv` complains about a missing `ensurepip` (Debian/Ubuntu without `python3-venv`), use
`python3 -m venv --without-pip .techdocs-venv` and install pip into it with
[`get-pip.py`](https://bootstrap.pypa.io/get-pip.py).

Without `CNPG_KUBE_CONTEXT` the backend uses your **current** kubeconfig context. Other settings are
under `cnpg:` in `app-config.yaml` (schema: `plugins/cnpg-backend/config.d.ts`).

### Platform docs and API reference

**Docs → Platform docs** is TechDocs for the `tuskpilot` System
([`catalog/catalog-info.yaml`](catalog/catalog-info.yaml)): the MkDocs site in
[`catalog/`](catalog/mkdocs.yml), pages under `catalog/docs/`. **Docs → API reference** is the API
docs plugin over the `PostgresCluster`, `Project` and `Location` APIs in
[`catalog/apis.yaml`](catalog/apis.yaml). That file and the OpenAPI documents in `catalog/apis/`
are generated from the XRDs: run `make generate` in `api/` after changing one; `make test` fails
while they're stale.

The backend builds the docs itself with MkDocs from the `PATH` (`techdocs.generator.runIn: local`),
locally from `.techdocs-venv` and in the image from `/opt/techdocs` (see `packages/backend/Dockerfile`).
Not in a container (`runIn: docker`): Backstage runs that container as your uid, which with rootless
podman can't read its own bind mounts. Check the pages before you push them:

```sh
cd catalog && ../.techdocs-venv/bin/mkdocs build --strict -d /tmp/site
```

### Grafana dashboards

Each PostgresCluster gets a `GrafanaDashboard` (grafana-operator) with a per-cluster uid, which the
XR reports in `status.monitoring.dashboardUid`. The portal embeds `<grafanaUrl>/d/<uid>` in kiosk mode.

For a cluster in a Project, `<grafanaUrl>` is the project's own Grafana (`status.grafana.url`, on
the control plane), so nothing needs configuring. Its panels show the locations' metrics only with
`prometheus.remoteWrite` in project-defaults (see
[Locations](../api/README.md#locations)). As a fallback, e.g. for a Grafana of your
own:

```sh
CNPG_GRAFANA_URL=https://grafana.example.com yarn start
```

- `{namespace}` in the fallback URL is replaced by the cluster's namespace, for one Grafana per
  namespace (the composition's default `instanceSelector` is `dashboards.paas.cndev.nl/scope: <namespace>`).
- Grafana must allow embedding and give the browser a session inside the iframe:

  ```yaml
  # Grafana CR (grafana-operator), spec.config
  security:
    allow_embedding: "true"
  auth.anonymous:            # or the same SSO as the portal
    enabled: "true"
    org_role: Viewer
  ```

- `backend.csp.frame-src` in `app-config.yaml` allows the iframe; narrow it to your Grafana host in
  production.
- Without `CNPG_GRAFANA_URL` the Monitoring tab explains how to connect Grafana instead.

### Locations

A location is a Kubernetes cluster the databases run in: a `Location` object (cluster-scoped, see
[`api`](../api/README.md#locations)) with the settings, pointing at a Secret
in the control plane's `cnpg-locations` namespace (`cnpg.locations.namespace`, label
`platform.cndev.nl/location=true`) that holds the kubeconfig under the `kubeconfig` key. The backend
writes the Secret first, then the Location. The kubeconfig never leaves the backend; the API returns
only server, context and auth type. The Location's composition creates the provider-kubernetes
`ClusterProviderConfig` the Project and PostgresCluster compositions place objects through. Its status
(connected, operators installed, a message) shows on the location pages next to the portal's own
health checks. Locations created with kubectl or GitOps show up the same way, and so does their
kubeconfig if its Secret is in `cnpg-locations`. The control plane itself is no location (`local`
is reserved).

A Project has a **protected** location, where its databases run, and optionally a **recovery**
location (**New project** > Locations; **Edit project** can add a recovery location later, but
neither changes once set). The create-cluster form shows the protected location and offers **Geo
replication** when the project has a recovery location; **Edit cluster** turns geo replication off,
and the cluster's **Disaster recovery** tab switches the **primary site** over (switchover, or
failover when the primary's site is down). The cluster detail page and the
Logs tab read pods, events and logs from both sites with that location's kubeconfig (a location
that doesn't answer shows as a warning, the rest of the page still loads). The `location` of a log
request must be one the cluster runs in; without one, the primary's.

On upload the backend keeps only the chosen context and **rejects** kubeconfigs that would run commands or read
files on the backend (`exec`, `auth-provider`, `token-file`, file paths for certificates) and plain-http
servers. For EKS, GKE or AKS with Entra ID, which use `exec`, create a ServiceAccount with a token instead:

```sh
kubectl -n kube-system create serviceaccount data-services-platform
kubectl create clusterrolebinding data-services-platform \
  --clusterrole=cluster-admin --serviceaccount=kube-system:data-services-platform   # or a narrower role
kubectl -n kube-system create token data-services-platform --duration=8760h        # paste as users[].user.token
```

Health checks, run from the portal backend (so a location must be reachable from where the portal runs):
the API server answers `/version` (else **Unreachable**), `/readyz`, Ready nodes (none Ready means
**Degraded**), whether CloudNativePG is installed, and whether it can mount extension images (**Image
volumes**: the API server keeps an image volume in a server-side dry-run Pod in `default`, and every
node runs containerd >= 2.1 or CRI-O >= 1.31; needed for CNPG extension images, PostgreSQL 18+). The
last two are warnings, not errors; `api/install/add-location.sh` runs the same checks. Removing a location
deletes the Location and then its Secret; nothing on that cluster changes. It's refused while a project
still uses the location, since Crossplane couldn't update or clean up what runs there without it. The
backend checks this first for a clear message, and the API server enforces it anyway: each Project holds
a `ClusterUsage` on its Locations.

### Look and feel

`packages/app/src/modules/theme` holds the Tuskpilot theme (the only theme) and the token overrides for
Backstage UI. `packages/app/src/modules/nav` holds the logo, the sidebar, the app shell and the
sign-in page. `app.packages.include` in `app-config.yaml` loads only the catalog and cnpg frontend
plugins; the other plugins stay in `packages/app/package.json` but are not bundled into the app.

## Test

```sh
yarn tsc
yarn test:all
yarn lint:all
```

## Deploy in the cluster

```sh
yarn install --immutable && yarn tsc && yarn build:backend
docker build -t <registry>/cnpg-portal:<tag> -f packages/backend/Dockerfile .
# set the image in deploy/backstage.yaml, then
kubectl apply -k deploy/
```

Deploy it on the control plane. `deploy/rbac.yaml` gives the ServiceAccount full access to
`postgresclusters`, get/list/create/patch/delete on `projects` (the backend deletes only a project
without PostgresClusters, and turns its deletion protection off for that), get/list/create/update/delete
on `locations`, get on the `postgres-sizes` EnvironmentConfig (the size catalog), read
access to namespaces, and access to Secrets **only** in the `cnpg-locations` namespace (the
locations' kubeconfigs). Pods, pod logs, events and CNPG Clusters are read in the locations with
their kubeconfigs. Backstage's own database is a plain CloudNativePG `Cluster`
(`deploy/database.yaml`): no PostgresCluster can run on the control plane, so install
[`operator`](../operator) there for it. Plugins share it per schema
(`pluginDivisionMode: schema`), because the CNPG app role can't create databases.

Before production: replace the guest auth provider with your IdP
(<https://backstage.io/docs/auth/>), and replace the allow-all permission policy with one that
restricts `cnpg.cluster.create`/`update`/`delete`, `cnpg.project.create`/`update`/`delete` and
`cnpg.location.create`/`update`/`delete` (a location is a kubeconfig, often cluster-admin: platform admins
only).

The scaffolder *frontend* isn't bundled (`app.packages.include`), so in the portal you create projects
and clusters with its own forms. The Software Templates and actions are registered in the backend, for
the scaffolder API, MCP actions, or a Backstage instance that does include the scaffolder UI.
