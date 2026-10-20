# BASIS

BASIS (Build AI Services In Sovereign infrastructure) is a platform for building generative AI
services on Kubernetes clusters you own. Teams order the building blocks of an AI service
themselves, through this portal or the Kubernetes API, and the platform runs them. It is built on
[Crossplane](https://www.crossplane.io/) and [Backstage](https://backstage.io/).

The target stack covers self-hosted models (vLLM, KServe, llm-d), an AI gateway, prompt and
semantic caches, RAG, guardrails, observability and orchestration. Today the platform provides the
context and data layer: PostgreSQL with pgvector on [CloudNativePG](https://cloudnative-pg.io/)
(CNPG), Prometheus and Grafana, and object storage. See [Platform scope](scope.md) for the full
stack and what is available now.

## What you get today

- **Self-service:** one `PostgresCluster` object, or the **New cluster** form, gives you a highly
  available cluster in a size from the platform's catalog (XS to XL), with PostgreSQL tuned to it.
- **Context / RAG:** the **Vector & RAG** profile (PostgreSQL 18) brings pgvector, VectorChord for
  large vector indexes and pg_search for BM25 and hybrid search. See [Vector & RAG](clusters/vector-rag.md).
- **Projects:** each team works in its own Project, with access control, an optional quota and
  deletion protection, and its own Prometheus and Grafana.
- **Observability:** metrics, alerts and a CloudNativePG dashboard for every cluster, in your
  Project's Grafana.
- **Backups and resilience:** continuous backups to object storage, point-in-time restore into a new
  cluster, and a replica cluster in a second location that can take over.
- **Sovereign:** everything runs in your own clusters, in the data centers or regions you choose.

## How it fits together

![Teams use the portal or the API on the control plane, which deploys the AI stack to every location: apps and agents send prompts through the AI gateway, which checks the cache and calls the model servers, and pull context from PostgreSQL; PostgreSQL archives WAL and backups to object storage, the recovery location replays them; metrics and traces go back to the control plane](diagrams/architecture.png){ width="784" }

<!-- Source: diagrams/architecture.mmd; ../render-diagrams.sh renders it. -->

- The **control plane** runs the APIs (Crossplane) and the portal, but no workloads.
- **Locations** are the Kubernetes clusters the services run in. In a location, apps and agents
  send prompts through the AI gateway, which applies guardrails, answers from the cache where it
  can and otherwise calls the self-hosted models; context for RAG comes from PostgreSQL.
- Solid green boxes are available today; dashed boxes are planned (see [Platform scope](scope.md)).
- A **Project** has a **protected** location, where its services run, and optionally a **recovery**
  location for replica clusters. The replica is fed through the Project's backup bucket, so the two
  locations need no network path to each other.

## Where to go next

| I want to | Read |
|---|---|
| See the full stack and what's coming | [Platform scope](scope.md) |
| Create my first database | [Getting started](getting-started.md) |
| Pick a size, extensions, HA or pooling | [Configure a cluster](clusters/configure.md) |
| Store embeddings and build RAG search | [Vector & RAG](clusters/vector-rag.md) |
| Move the primary to the other location | [Geo replication and disaster recovery](clusters/disaster-recovery.md) |
| Restore to a point in time | [Backups and restore](clusters/backup-restore.md) |
| Automate it (GitOps, CI) | [API reference](api.md) |
| Run the platform | [Architecture](platform/architecture.md), [Install](platform/install.md), [Catalogs](platform/catalogs.md), [Upgrades](platform/upgrades.md) |
| Find out what's wrong | [Troubleshooting](platform/troubleshooting.md), [Monitoring](platform/monitoring.md) |
