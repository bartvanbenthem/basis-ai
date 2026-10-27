# GenAI stacks

A `GenAIStack` (`ai.cndev.nl/v1alpha1`) is the platform side of a generative AI service, in one
object in your Project:

| Part | What | Named |
|---|---|---|
| Retrieval | PostgreSQL 18 with the vector profile (pgvector, VectorChord, pg_search), with a role of the stack's own | `PostgresCluster <name>-db` |
| Cache | Valkey, exact or semantic (valkey-search), one node so any client works | `ValkeyCache <name>-cache` (and `<name>-cache-dr`) |
| Gateway | An OpenAI-compatible endpoint to your models: the stack's own, or a shared one | `ModelGateway <name>-gateway`, or `spec.gateway.ref` |
| Wiring | One Secret per site with every endpoint and credential | `Secret <name>-connection` |

Create one in the portal (**AI services → New stack**) or with `kubectl` (see
[Getting started](../getting-started.md)). It needs the Valkey operator and Envoy Gateway with Agent
Router in the Project's locations (the platform team installs them).

## Settings

| Field | Default | What |
|---|---|---|
| `retrieval.cpu`, `.memory` | `500m`, `1Gi` | Per database instance; memory is request and limit, and PostgreSQL is tuned to it |
| `retrieval.instances`, `.storageSize` | `3`, `20Gi` | |
| `retrieval.extensions` | `[vector]` | From the extension catalog, e.g. `vchord`, `pg_search` |
| `retrieval.backup` | off | Continuous backups to the Project's bucket; always on with recovery |
| `retrieval.auditLog` | off | Audit logging with pgaudit: the statement classes to record, e.g. `ddl, role` or `write, ddl, role`. The project's **Audit logs** page shows the records. Turning it on or off restarts the instances one at a time |
| `cache.enabled`, `.mode` | on, `semantic` | `exact` or `semantic` (vector search on prompts) |
| `cache.memory`, `.cpu`, `.evictionPolicy` | `1Gi`, `500m`, `allkeys-lru` | Of the active site's cache |
| `gateway.enabled` | on | |
| `gateway.models` | | The stack's own gateway's models (see [Model gateways](model-gateways.md#models)) |
| `gateway.replicas` | `2` | The stack's own gateway in the active site |
| `gateway.ref`, `gateway.client` | | A shared ModelGateway instead, and the stack's client there (the stack's name by default) |
| `recovery.enabled` | off | A warm standby in the Project's recovery location |
| `recovery.activeSite`, `.promotion` | `protected`, `Switchover` | Where the stack serves from; see [Switching sites](#switching-sites) |
| `recovery.cacheMemory`, `.gatewayReplicas` | `512Mi`, `1` | The standby's smaller cache and gateway |
| `retrieval.expose.enabled`, `.loadBalancerSourceRanges` | off | The database on a LoadBalancer with TLS, for clients outside the location; see [Outside the location](#outside-the-location) |
| `gateway.expose.enabled`, `.hostname`, `.loadBalancerSourceRanges` | off | The stack's own gateway over HTTPS ([Expose it](model-gateways.md#expose-it)) |
| `deletionProtection` | on | Deleting the stack deletes its database: turn it off first |

## The connection Secret

`<name>-connection`, in the Project's namespace in every site's location, the same keys in each:

| Key | What |
|---|---|
| `SITE`, `ACTIVE` | `protected` or `recovery`; `true` in the site that serves |
| `DATABASE_URL`, `DATABASE_HOST`, `_PORT`, `_NAME`, `_USER`, `_PASSWORD` | The stack's role in database `app`, through the read-write service |
| `VALKEY_URL`, `VALKEY_HOST`, `_PORT`, `_PASSWORD`, `VALKEY_CLUSTER` | The site's cache (`VALKEY_CLUSTER=false`: a plain client works) |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | The gateway and the stack's key for it |

Use cache keys of tenant + model + system-prompt version + corpus version + the prompt (or a TAG
filter in a semantic lookup). Keep the corpus version in a table of the RAG database and bump it
with each ingestion batch: old answers stop matching, and each site's cache stays consistent with its
own database.

## The stack's parts are the stack's

The database, caches and gateway carry the label `ai.cndev.nl/genaistack: <name>`. The API server
refuses changing or deleting them directly: change the stack instead (**Edit** on its page, or
`kubectl edit genaistack`). Their own pages in the portal show them read-only, with a link to the
stack. Anything you need beyond the stack's settings is a [building block](../scope.md#apis) of
your own next to it.

## A shared gateway

Several stacks, agents and apps can share one [model gateway](model-gateways.md): one set of
models and provider keys, a key per client, one place to see who calls what. Set `gateway.ref` to
the gateway's name and add a client for the stack (named after it, or `gateway.client`) to the
gateway's `clients`. The stack then composes no gateway of its own; its connection Secret holds the
shared gateway's endpoint and the stack's client key. With recovery, the shared gateway needs a
standby too.

## Outside the location

Everything is internal by default: the app runs in the stack's location and uses the connection
Secret. For ingestion jobs, agents and tools elsewhere, expose the database or the gateway:

```yaml
spec:
  retrieval:
    expose:
      enabled: true
      loadBalancerSourceRanges: [203.0.113.10/32]   # never open to everyone
  gateway:
    expose:
      enabled: true
      hostname: bot.example.com                     # its DNS record is yours
      loadBalancerSourceRanges: [0.0.0.0/0]
```

- **Database**: Service `<name>-db-external` in each site's location, TLS with the CA in Secret
  `<name>-db-ca`; connect as the stack's role (`DATABASE_USER`, `DATABASE_PASSWORD`) with
  `sslmode=verify-full` (see the database's page for the address).
- **Gateway**: `https://<hostname>/v1` (`status.gatewayExternalEndpoint`), with the stack's key
  (`OPENAI_API_KEY`). A shared gateway is exposed on the gateway itself.
- **Cache**: always internal; it has no TLS, and it only pays off next to the app.

The connection Secret keeps the internal addresses. With recovery, each site has its own load
balancer: after a switchover, clients outside follow the new active site.

## Switching sites

With `recovery.enabled`, the recovery location runs a warm standby: a replica of the database (fed
from the Project's backup bucket), a small cold cache and a minimal gateway. To move the stack:

- **Switch site** on the stack's page, or set `spec.recovery.activeSite: recovery`. The database
  demotes its primary first and promotes the replica once it has everything, so nothing is lost.
- With the active site down, choose **Fail over** (`promotion: Failover`): the replica is promoted
  right away; what the old site hadn't archived yet is lost.

`status.activeSite` follows the database: once it has moved, the new site gets the full-size cache
and gateway and its connection Secret says `ACTIVE=true`. Deploy the app in both sites; route
traffic to the active one. Turning recovery off needs `activeSite: protected`.

## Troubleshooting

`kubectl describe genaistack <name> -n <project>` shows `status.message` and the `StackReady`
condition.

| Message | Fix |
|---|---|
| `Project ... has no recovery location` | Add `spec.locations.recovery` to the Project, or turn recovery off |
| `waiting for cache <name>-cache's password` | The cache is starting; see its page |
| `no ModelGateway <ref> in namespace ...` | Create it, or fix `gateway.ref` |
| `ModelGateway <ref> has no client <client>` | Add the client to the gateway's `spec.clients` |
| `ModelGateway <ref> has no recovery site` | Turn on the gateway's `recovery.enabled` |
| `Switching the active site to ...` | The database is moving its primary; see its Disaster recovery tab |
| `... belongs to GenAIStack ...` (refused) | Change the stack, not its parts |
