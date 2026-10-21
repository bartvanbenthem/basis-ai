# Platform scope

Generative AI services and agents increasingly call hosted frontier models (Claude, GPT, ...). The
model is someone else's; everything around it doesn't have to be. BASIS is that part, on
infrastructure you own: the data an agent retrieves, its memory and caches, the gateway that holds
the provider keys and decides who may call which model, and the record of what happened. It works
the same with self-hosted models, for what must stay inside, and for the small models next to the
big one (embeddings, classification, guardrails).

Every part runs in your own Kubernetes clusters (locations), is ordered through the same Kubernetes
API, this portal or an agent (MCP), and is operated by the platform.

## The stack

| Layer | Components | Status |
|---|---|---|
| AI service | `GenAIStack`: retrieval, cache, gateway and wiring in one object | **Available** |
| Model gateway | `ModelGateway` on [Agent Router](https://aigateway.envoyproxy.io/) (Envoy Gateway): hosted and self-hosted models, a key per client | **Available**; token budgets, guardrails and per-client metrics planned |
| Agents | MCP tools for the platform (Backstage MCP actions), `llms.txt` | **Available**; MCP servers per Project for retrieval and memory planned |
| Context / RAG | PostgreSQL on [CloudNativePG](https://cloudnative-pg.io/) with pgvector, VectorChord and pg_search | **Available** |
| Exact / semantic cache | [Valkey](https://valkey.io/) | **Available** |
| Self-hosted models | [vLLM](https://docs.vllm.ai/) on [KServe](https://kserve.github.io/website/), [llm-d](https://llm-d.ai/) prefix-cache-aware routing | Planned (a gateway routes to your own servers today) |
| Guardrails | At the gateway: PII filtering, prompt-injection checks, content policies | Planned |
| Observability | [Prometheus](https://prometheus.io/) and [Grafana](https://grafana.com/) per Project; [OpenTelemetry](https://opentelemetry.io/) traces of agent runs | **Available** (Prometheus, Grafana); OpenTelemetry planned |
| Object storage | A bucket per Project through [COSI](https://github.com/kubernetes-sigs/container-object-storage-interface) | **Available** |

## APIs

Three levels, each for its own audience:

| Level | APIs | For |
|---|---|---|
| Product | `GenAIStack` | Teams building an AI service: the default way in |
| Building blocks | `ModelGateway`, `PostgresCluster`, `ValkeyCache` | What a stack is made of, on its own: a gateway shared by stacks and agents, a database for an agent's memory, a cache for tool results |
| Platform | `Project`, `Location`, the catalogs | Platform admins |

A stack composes building blocks next to it and owns them: they change only through the stack.
Building blocks of your own sit beside it in the same Project.

## How a request flows

```text
 App or agent (in the location)
   │  OPENAI_BASE_URL, its own key
   ▼
 Model gateway (Agent Router)
   │   routes on the model; swaps the client key for the provider's
   ├──▶ hosted models (Anthropic, OpenAI, Mistral, ...)
   └──▶ self-hosted models (vLLM, KServe, Ollama)

 The app also uses:
   Cache (Valkey) ─────── exact and semantic answers, tool results
   Context (PostgreSQL) ─ documents, embeddings, agent memory

 Everything ── metrics, traces ──▶ Prometheus, Grafana (OpenTelemetry)
 Databases ─── WAL, backups ─────▶ object storage (COSI) ──▶ the standby site
```

## What's next

- **Governance at the gateway:** token budgets and rate limits per client, an audit log of who
  called which model, PII redaction before a prompt leaves.
- **MCP servers per Project:** retrieval over a stack's database and the agent's memory as tools,
  under the Project's access control.
- **Agent observability:** OpenTelemetry traces of agent runs (tool calls, tokens, cost) per Project.
- **Self-hosted inference:** vLLM on KServe for embeddings, guardrail models and air-gapped sites.
