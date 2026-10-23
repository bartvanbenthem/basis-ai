# BASIS

BASIS (Build AI Services In Sovereign infrastructure) is the platform side of generative AI services
and agents, on Kubernetes clusters you own. The model can be anyone's: Claude, GPT, Mistral or one
you serve yourself. What stays with you is everything around it: your data and its retrieval, the
caches, the gateway that holds the provider keys and knows who calls which model, and the audit
trail. Teams order it themselves, through this portal, the Kubernetes API or an agent, and the
platform runs it. Built on [Crossplane](https://www.crossplane.io/) and
[Backstage](https://backstage.io/).

## What you get today

- **GenAI stacks:** one `GenAIStack` object, or **AI services → New stack**, gives your service a
  RAG database, a cache and a model gateway, wired together in one Secret your app mounts. With a
  warm standby in a second location if you want one. See [GenAI stacks](ai/genai-stacks.md).
- **Model gateways:** one OpenAI-compatible endpoint to hosted and self-hosted models. Provider keys
  stay in the platform; every app, agent and stack gets a key of its own. See
  [Model gateways](ai/model-gateways.md).
- **Self-hosted models:** open models on your own GPUs with vLLM, behind the same gateway, routed to
  the replica that has the prompt's prefix cached. See [Model servers](ai/model-servers.md).
- **Agents welcome:** the platform as MCP tools and a Kubernetes API with schemas, dry runs and
  admission rules that explain themselves. Agents work within your permissions. See
  [Agents and MCP](ai/agents.md).
- **A knowledge base and memory for agents:** an MCP server per Project, with hybrid search over
  your stack's database and a memory per agent, a key per agent, every call audited. See
  [MCP servers](ai/mcp-servers.md).
- **Building blocks:** the parts on their own when a stack doesn't fit: highly available
  PostgreSQL (with pgvector, VectorChord and pg_search for RAG), exact and semantic Valkey caches,
  model gateways.
- **Projects:** each team works in its own Project, with access control, an optional quota and
  deletion protection, and its own Prometheus and Grafana.
- **Observability:** metrics, alerts and dashboards for every database and cache, in your Project's
  Grafana.
- **Resilience:** continuous backups to object storage, point-in-time restore, and a standby site
  that can take over.
- **Sovereign:** everything runs in your own clusters, in the data centers or regions you choose.

## How it fits together

![Teams use the portal, the API or an agent on the control plane, which deploys the AI stack to every location: apps and agents send prompts through the model gateway, which calls hosted or self-hosted models, use the cache, and pull context from PostgreSQL; PostgreSQL archives WAL and backups to object storage, the recovery location replays them; metrics and traces go back to the control plane](diagrams/architecture.png){ width="784" }

<!-- Source: diagrams/architecture.mmd; ../render-diagrams.sh renders it. -->

- The **control plane** runs the APIs (Crossplane) and the portal, but no workloads.
- **Locations** are the Kubernetes clusters the services run in. In a location, apps and agents
  send prompts through the model gateway, look up the cache and pull context for RAG from
  PostgreSQL.
- Solid green boxes are available today; dashed boxes are planned (see [Platform scope](scope.md)).
- A **Project** has a **protected** location, where its services run, and optionally a **recovery**
  location for standbys. Databases replicate through the Project's backup bucket, so the two
  locations need no network path to each other.

## Where to go next

| I want to | Read |
|---|---|
| Run an AI service: RAG, cache, models | [Getting started](getting-started.md), [GenAI stacks](ai/genai-stacks.md) |
| Give apps and agents access to models | [Model gateways](ai/model-gateways.md) |
| Run an open model on our own GPUs | [Model servers](ai/model-servers.md) |
| Let an agent build on the platform | [Agents and MCP](ai/agents.md) |
| Give agents our documents and a memory | [MCP servers](ai/mcp-servers.md) |
| See the full stack and what's coming | [Platform scope](scope.md) |
| A database on its own | [Create a cluster](clusters/create.md), [Configure a cluster](clusters/configure.md), [Vector & RAG](clusters/vector-rag.md) |
| A cache on its own | [Valkey caches](caches/valkey.md) |
| Move a service to the other location | [GenAI stacks](ai/genai-stacks.md#switching-sites), [Geo replication and disaster recovery](clusters/disaster-recovery.md) |
| Restore to a point in time | [Backups and restore](clusters/backup-restore.md) |
| Automate it (GitOps, CI) | [API reference](api.md) |
| Run the platform | [Architecture](platform/architecture.md), [Install](platform/install.md), [Catalogs](platform/catalogs.md), [Upgrades](platform/upgrades.md) |
| Find out what's wrong | [Troubleshooting](platform/troubleshooting.md), [Monitoring](platform/monitoring.md) |
