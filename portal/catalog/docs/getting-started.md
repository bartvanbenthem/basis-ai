# Getting started

The shortest path to a working AI service: a Project, then a GenAI stack in it, then your app (or
agent) mounting one Secret.

## 1. A Project

Everything lives in a **Project**: your team's namespace, with its locations, access, and its own
Prometheus and Grafana. If your team has none yet, ask the platform team, or create one under
**Platform → Projects** if you're allowed to.

## 2. A GenAI stack

A `GenAIStack` is the platform side of an AI service in one object: a RAG database (PostgreSQL with
pgvector), a cache (Valkey) and a model gateway for your models, wired together.

### In the portal

1. Open **AI services → New stack**.
2. Pick your **Project** and a **name**, and add your **models**: what your app sends as `model`,
   the provider's endpoint, and the Secret with the provider's API key. Or pick a shared
   [model gateway](ai/model-gateways.md) of the project.
3. **Validate** checks the manifest against the API without creating anything; **Create stack**
   creates it.

### With kubectl

Put the provider's key in a Secret first, then the stack:

```sh
kubectl -n team-payments create secret generic anthropic --from-literal=apiKey=sk-ant-...
```

```yaml
apiVersion: ai.cndev.nl/v1alpha1
kind: GenAIStack
metadata:
  name: support-bot
  namespace: team-payments     # your Project
spec:
  gateway:
    models:
      - name: claude
        endpoint: https://api.anthropic.com/v1
        schema: Anthropic
        apiKeySecretRef:
          name: anthropic
```

```sh
kubectl apply -f support-bot.yaml
kubectl get genaistack -n team-payments support-bot -w    # READY True
```

## 3. Connect your app

The stack writes Secret `support-bot-connection` into your Project's namespace in its location, with
everything the app needs. Mount it:

```yaml
envFrom:
  - secretRef:
      name: support-bot-connection
```

`DATABASE_URL` is the RAG database, `VALKEY_URL` the cache, and `OPENAI_BASE_URL` plus
`OPENAI_API_KEY` the gateway, for any OpenAI SDK (`model: claude`). See
[GenAI stacks](ai/genai-stacks.md) for every key.

## 4. Watch it

The stack's page shows its health, sites, components and the wiring, and links to the database, cache
and gateway, each with their own monitoring. Alerts go to your Project's Prometheus.

## What else

- A database, cache or gateway on its own: [Building blocks](scope.md#apis).
- Let an agent (Claude Code, Codex) do this for you: [Agents and MCP](ai/agents.md).
