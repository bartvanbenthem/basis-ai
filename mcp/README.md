# mcp/: basis-mcp

The MCP server every `MCPServer` ([`api/apis/mcpserver`](../api/apis/mcpserver/definition.yaml))
runs in its Project's location. It serves a Project's knowledge base and its agents' memory as MCP
tools over streamable HTTP, on the Project's PostgreSQL. For using it, see
[MCP servers](../portal/catalog/docs/ai/mcp-servers.md); this page is about the server itself.

| Tool | SQL side |
|---|---|
| `search`, `fetch` | The documents table: the server's own `mcp.documents`, or one of yours (`retrieval.table`, only read) |
| `add_document`, `delete_document` | `mcp.documents` (with `retrieval.ingest`) |
| `remember`, `recall`, `forget` | `mcp.memories`, scoped by client unless `memory.scope` is `shared` |

## How it works

```text
 agent ── POST /mcp, Bearer <key> ──▶ auth (keys dir) ──▶ the client's MCP server (its tools only)
                                                              │
                                     embeddings (OPENAI_BASE_URL/embeddings) ◀─┤
                                                              ▼
                                     PostgreSQL (DATABASE_URL): pgvector + full text
```

- **Stateless streamable HTTP** (JSON responses, [rmcp](https://github.com/modelcontextprotocol/rust-sdk),
  the official MCP Rust SDK), so any replica answers any request and the Service needs no session
  affinity. Each client gets an MCP server holding only the tools it may call; `tools/list` shows
  nothing else.
- **Keys** are the files of a mounted Secret (file name = client), re-read every 15s, so revoking
  needs no restart. A key holder the config doesn't list gets no tools.
- **Search** ranks candidates by cosine distance (`<=>`, HNSW index) and by `ts_rank_cd` over
  `websearch_to_tsquery` (GIN index on the same expression), `topK × 4` each, and fuses them by
  reciprocal rank (k = 60). If the model fails, hybrid search returns full-text hits with a warning.
- **Tables** are created on the primary under an advisory lock taken before the DDL's transaction,
  so replicas that start together don't race (one that waited sees what the other created). The vector dimensions come from the existing column, or else from
  asking the model once. A model with other dimensions than the column's is refused. On a replica
  (`pg_is_in_recovery()`) the server creates nothing and refuses writes with a clear error.
- **Backfill** embeds rows stored without a vector (the model was down, or `embeddings.model` came
  later) every 30s. Memories past `retentionDays` are deleted hourly.
- **Identifiers** (tables, columns, the text search configuration) come only from the config,
  checked against strict patterns before they're quoted into SQL; values are always parameters.

Readiness (`/readyz`) is the store's state: the database answers, the extension, tables and columns
are there, the model returns vectors of the right size. The pods are only ready once the server can
answer; the log says what it waits for.

## Interfaces

| | |
|---|---|
| `--config` | `config.json`, written by the composition (`config::Config`: the spec with defaults applied) |
| `--keys` | Directory with a file per client holding its key |
| `DATABASE_URL` (+ `PGUSER`, `PGPASSWORD`) | The database; libpq's variables fill in what the URL leaves out |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | The embeddings endpoint (the Project's ModelGateway) and the server's key there |
| `:8080` | `/mcp`, `/healthz`, `/readyz` |
| `:9090` | `/metrics`: `basis_mcp_tool_calls_total{tool,client,outcome}`, `basis_mcp_tool_duration_seconds`, `basis_mcp_tool_results`, `basis_mcp_embedding_requests_total`, `basis_mcp_embedding_duration_seconds`, `basis_mcp_database_ready`, `basis_mcp_backfilled_embeddings_total`, `basis_mcp_expired_memories_total` |
| stdout | One audit line per tool call: `{"basis":"mcp","time","server","client","tool","outcome","duration_ms","results","id","error"}`, never the query or content. Logs go to stderr |

## Develop

```sh
make test       # clippy, unit tests; the store's tests are skipped
make test-db    # the same, plus the store against pgvector/pgvector:pg18 in podman
make image      # docker build, tagged ghcr.io/bartvanbenthem/basis-mcp:$(VERSION)
make push       # and push it
```

The store's tests run against any PostgreSQL with pgvector:
`BASIS_MCP_TEST_DATABASE_URL=postgres://app:test@127.0.0.1:55432/app cargo test`. Each test
works in a schema of its own and drops it afterwards.

A release: bump `VERSION` here and `DEFAULT_IMAGE` in
[`api/function/src/mcpserver.rs`](../api/function/src/mcpserver.rs), `make push`, then
publish function-basis as usual ([Releasing function-basis](../api/README.md#releasing-function-basis)).
