# Platform scope

BASIS (Build AI Services In Sovereign infrastructure) is growing from a managed PostgreSQL platform
into a complete stack for running generative AI services on infrastructure you own. Every layer runs
in your own Kubernetes clusters (locations), is ordered through the same Kubernetes API or this
portal, and is operated by the platform.

This page describes the target stack. Layers marked **Available** can be used today; the rest are
**Planned** and not part of the platform yet.

## The stack

| Layer | Components | Status |
|---|---|---|
| Model API (self-hosted) | [vLLM](https://docs.vllm.ai/), [KServe](https://kserve.github.io/website/), [llm-d](https://llm-d.ai/) | Planned |
| Router / gateway | [Gateway API Inference Extension](https://gateway-api-inference-extension.sigs.k8s.io/), [Envoy AI Gateway](https://aigateway.envoyproxy.io/) or [agentgateway](https://agentgateway.dev/) | Planned |
| Prompt / KV cache | llm-d prefix-cache-aware routing | Planned |
| Exact / semantic cache | [Valkey](https://valkey.io/) | Planned |
| Context / RAG | PostgreSQL on [CloudNativePG](https://cloudnative-pg.io/) with pgvector, VectorChord and pg_search | **Available** |
| Guardrails | To be decided | Planned |
| Observability | [Prometheus](https://prometheus.io/) and [Grafana](https://grafana.com/) per Project; [OpenTelemetry](https://opentelemetry.io/) | **Available** (Prometheus, Grafana); OpenTelemetry planned |
| Object storage | A bucket per Project through [COSI](https://github.com/kubernetes-sigs/container-object-storage-interface) | **Available** |
| Orchestration | [LangGraph](https://langchain-ai.github.io/langgraph/) | Planned |

## How a request flows

```text
 Application / agent (LangGraph)
   │
   ▼
 Gateway (Envoy AI Gateway or agentgateway, Gateway API Inference Extension)
   │   guardrails on the way in and out
   ├──▶ Exact / semantic cache (Valkey) ── hit ──▶ answer
   │
   ▼   prefix-cache-aware routing (llm-d)
 Model servers (vLLM on KServe)
   ▲
   │   context
 Context / RAG (PostgreSQL + pgvector on CNPG)

 Everything ── metrics, traces ──▶ Prometheus, Grafana (OpenTelemetry)
 Databases, model artifacts ──────▶ object storage (COSI)
```

## Layers

### Model API (self-hosted)

Open-weight models served with vLLM, deployed and scaled by KServe, with llm-d for distributed
inference across GPUs and nodes. Models run in your own locations, so prompts and outputs never
leave your infrastructure.

### Router / gateway

One OpenAI-compatible entry point per Project. The Gateway API Inference Extension picks a model
server per request based on load and model; Envoy AI Gateway or agentgateway adds authentication,
rate limits, token budgets and routing between models.

### Prompt / KV cache

llm-d routes requests that share a prompt prefix (system prompts, long documents, chat history) to
the model server that already holds that prefix in its KV cache, which cuts time to first token and
GPU work.

### Exact / semantic cache

Valkey stores answers to prompts seen before. An exact match is answered without calling a model;
a semantic match uses embeddings to find prompts that mean the same thing.

### Context / RAG

PostgreSQL clusters with the **Vector & RAG** profile: pgvector for embeddings, VectorChord for large
vector indexes and pg_search for BM25 and hybrid search, highly available, backed up and replicated
to a second location. See [Vector & RAG](clusters/vector-rag.md).

### Guardrails

Input and output checks at the gateway: prompt-injection detection, PII filtering and content
policies, applied per Project.

### Observability

Each Project has its own Prometheus and Grafana, with metrics, alerts and dashboards for every
service it runs (see [Monitoring](platform/monitoring.md)). OpenTelemetry will add traces across the
gateway, model servers, caches and databases, plus token and latency metrics per model.

### Object storage

Each Project gets a bucket through COSI, used today for database backups and WAL archiving, and
later for model weights and documents for RAG.

### Orchestration

LangGraph for agents and multi-step workflows that combine the model API, the caches and the
context store.
