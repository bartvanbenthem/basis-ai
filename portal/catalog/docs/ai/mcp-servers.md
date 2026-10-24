# MCP servers

An `MCPServer` (`ai.cndev.nl/v1alpha1`) gives your Project's agents two things as
[MCP](https://modelcontextprotocol.io/) tools: your **knowledge base** and a **memory** of their
own. It runs in your Project's location, on your Project's database. Claude Code, Codex, or an agent
you build connect to it like to any MCP server.

- **Your data stays yours.** Documents, memories and their embeddings live in your stack's (or
  cluster's) PostgreSQL. The embeddings come from your Project's model gateway, which can be a model
  on your own GPUs.
- **A key per agent.** Every client gets a key of its own. You can limit a client to some tools: a
  support bot that may only search and recall, say. Removing a client revokes its key.
- **Audited and monitored.** Every tool call is on the Project's Audit logs page: who called which
  tool and how it went, never the query or the content. Metrics, alerts and a dashboard are in the
  Project's Grafana.

## The tools

| Tool | What | Served when |
|---|---|---|
| `search` | The best documents for a query: hybrid (vector similarity and full-text rank, fused), with an optional metadata filter | `retrieval.enabled` (default) |
| `fetch` | A whole document by the id `search` gave | `retrieval.enabled` |
| `add_document`, `delete_document` | Fill and prune the knowledge base | `retrieval.ingest` |
| `remember` | Store a memory: a fact, preference, decision or outcome, with tags | `memory.enabled` (default) |
| `recall` | The memories most relevant to a query, or the most recent ones | `memory.enabled` |
| `forget` | Delete a memory | `memory.enabled` |

The server tells the agent how to use them: search before answering from general knowledge, recall
at the start of a task, remember what will matter later (never secrets).

## Create one

Over a [GenAI stack](genai-stacks.md): the server uses the stack's database and role, and the
stack's gateway for the embeddings. Add an embeddings model to the stack's models first:

```yaml
  gateway:
    models:
      - name: text-embedding-3-small
        endpoint: https://api.openai.com/v1
        apiKeySecretRef: {name: openai}
```

Or a self-hosted one, a [model server](model-servers.md) serving e.g. `BAAI/bge-m3`. Then:

```yaml
apiVersion: ai.cndev.nl/v1alpha1
kind: MCPServer
metadata:
  name: support-kb
  namespace: team-payments
spec:
  database:
    stack: support-bot
  embeddings:
    model: text-embedding-3-small
  retrieval:
    ingest: true                  # agents may add and delete documents
  clients:
    - name: claude-code
    - name: support-bot
      tools: [search, fetch, recall]
```

Or in the portal: **AI services → MCP servers → Create MCP server**. Without an embeddings model,
search and recall are full-text only, which works without any model.

`kubectl get mcpserver -n team-payments` shows the database, the number of tools and clients, and
whether it's ready. It's ready once its pods have their database and tables.

## Connect an agent

Agents in the Project's location connect to `http://<name>.<project>.svc/mcp` (streamable HTTP)
with `Authorization: Bearer <key>`. The keys are in Secret `<name>-keys` (one per client, named
after it); in the portal, **Show keys** on the server's page, with `basis.mcp.credentials.read`.

The server is internal to its location. From your machine, use a port-forward, e.g. for Claude
Code:

```sh
kubectl -n team-payments port-forward svc/support-kb 8080:80
claude mcp add --transport http support-kb http://localhost:8080/mcp \
  --header "Authorization: Bearer <claude-code's key>"
```

An app or agent in the location, with any MCP SDK:

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client("http://support-kb.team-payments.svc/mcp",
                                 headers={"Authorization": f"Bearer {key}"}) as (r, w, _):
    async with ClientSession(r, w) as session:
        await session.initialize()
        hits = await session.call_tool("search", {"query": "refund policy", "limit": 5})
```

## The knowledge base

By default the server keeps documents in its own table, `mcp.documents` (title, source, content,
metadata, embedding), which it creates and indexes in the database. Fill it with `add_document`
(`retrieval.ingest`), or insert rows yourself: rows without an embedding are embedded within a
minute.

Do you already have a documents table, e.g. one your ingestion pipeline fills? Point the server at
it. It only reads that table:

```yaml
  retrieval:
    table: public.chunks
    columns:
      id: chunk_id          # required
      content: body         # required
      title: heading        # the others are optional
      source: url
      metadata: attrs       # jsonb, for search filters
      embedding: vec        # vector(n), from the same model as embeddings.model
    textSearchConfig: english
```

Give a table of your own the indexes its searches use: a GIN index on
`to_tsvector('english'::regconfig, coalesce(heading, '') || ' ' || coalesce(body, ''))` (without a
title, `coalesce(body, '')`), and an HNSW index on `vec vector_cosine_ops`.

**Search modes.** `hybrid` (the default with a model) ranks by vector similarity and by full-text
rank, and fuses both rankings. `vector` or `text` uses one of them. `textSearchConfig` is
PostgreSQL's text search configuration: `simple` (the default) works for any language without
stemming; `english`, `dutch`, `german` and so on stem their own language. If the embeddings model
can't be reached, a hybrid search returns full-text hits and says so.

## Memory

`remember` stores one memory per call, with tags; `recall` finds the most relevant ones for a
query, or returns the most recent without one. With `memory.scope: client` (the default) each
client only sees and forgets its own memories. With `shared`, every client of the server sees all
of them, each with the client that wrote it. `memory.retentionDays` deletes memories older than
that.

## Both sites

With `recovery.enabled` (and the stack's or cluster's database geo-replicated) a standby runs in
the Project's recovery location. The active site is wherever the database's primary is: switch the
stack over and the server follows. The standby answers `search`, `fetch` and `recall` from the
replica. It refuses writes, saying they go to the active site, until the primary moves there.

## Settings

| Field | Default | What |
|---|---|---|
| `database.stack` or `.cluster` | required, one of them | A GenAIStack or PostgresCluster in the Project |
| `database.name`, `.credentialsSecretRef.name` | `app`, the database owner | With a cluster: its database, and a basic-auth Secret of one of its roles (required with `recovery`) |
| `embeddings.model` | none (full text only) | The embeddings model, as the gateway names it |
| `embeddings.gateway`, `.client` | –, the server's name | With a cluster: the ModelGateway serving the model, and the server's client there (add it to the gateway's clients) |
| `embeddings.dimensions` | the model's | For models that can shorten their vectors |
| `retrieval.enabled`, `.mode`, `.topK` | on, `hybrid` (`text` without a model), `8` | Search |
| `retrieval.textSearchConfig` | `simple` | PostgreSQL's text search configuration |
| `retrieval.ingest` | off | `add_document` and `delete_document` (the server's own table only) |
| `retrieval.table`, `.columns` | `mcp.documents` | A documents table of your own, only read |
| `memory.enabled`, `.scope`, `.retentionDays` | on, `client`, forever | Memory |
| `clients[]` | `[{name: agents}]` | `name`, `owner`, `tools` (unset: all), `expiresAt` (YYYY-MM-DD, the key's last day) |
| `replicas`, `resources.cpu`, `.memory` | `2`, `250m`, `256Mi` | In the active site; any replica answers any request |
| `recovery.enabled`, `.replicas` | off, `1` | The standby in the recovery site |
| `alerts.errorRatePercent`, `.latencySeconds`, `.disabled` | `5`, `2`, off | See [Monitoring](#monitoring) |
| `image` | the platform's basis-mcp | Another build, e.g. from your own registry |

## Monitoring

Each server gets a dashboard in the Project's Grafana (folder *MCP servers*). It shows tool calls,
failures and latency per tool, calls per client, hits per search (few hits means the knowledge base
lacks what agents look for), the embeddings model's calls and latency, and whether the database is
ready.

The Project's Prometheus alerts, in each site with replicas:

| Alert | When (default) |
|---|---|
| `BasisMCPServerDown` | No replica up for 10 minutes |
| `BasisMCPServerDatabaseNotReady` | The server can't use its database for 10 minutes (its log says why) |
| `BasisMCPServerErrors` | More than `errorRatePercent` (5%) of tool calls fail for 10 minutes |
| `BasisMCPServerSlow` | 95% of tool calls take longer than `latencySeconds` (2s), for 15 minutes |
| `BasisMCPServerEmbeddingsFailing` | With a model: most calls to it fail for 10 minutes |

## Troubleshooting

`kubectl describe mcpserver <name> -n <project>` shows `status.message`, the sites and the
`MCPServerReady` condition. When the pods run but aren't ready, their log in the location says what
the server waits for.

| Symptom | Cause | Fix |
|---|---|---|
| `no GenAIStack <name> in namespace ...` | A typo in `database.stack`, or the stack is gone | The stack's name in the same Project |
| `ModelGateway <gw> has no client <name> for the embeddings` | The gateway has no key for the server | Add the client to the gateway's `clients` |
| `GenAIStack ... has no gateway for the embeddings` | The stack runs without a gateway | Turn on the stack's gateway, or remove `embeddings.model` |
| Log: `the database has no vector extension` | A cluster without pgvector | Add `vector` to the PostgresCluster's `database.extensions` |
| Log: `embeddings model ... answered 404` | The gateway doesn't serve that model | Add it to the gateway's (or stack's) models |
| Log: `returns N dimensions, the tables hold M` | Another embeddings model than the tables were made for | Keep the model, or use new tables: another `retrieval.table` and a new server |
| `401` from the server | No key, a wrong one, or a revoked one | The client's key from `<name>-keys`; an expired client is in `status.expiredClients` |
| `unknown tool` | The client may not call it | The client's `tools` |
| A write says `read-only replica (the standby site)` | The agent reached the standby | Use the active site's server; it moves with the database |
