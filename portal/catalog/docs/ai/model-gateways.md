# Model gateways

A `ModelGateway` (`ai.cndev.nl/v1alpha1`) is one OpenAI-compatible endpoint to your Project's models:
hosted ones (Anthropic, OpenAI, Mistral, ...) and self-hosted ones (vLLM, KServe, Ollama). It runs
[Agent Router](https://aigateway.envoyproxy.io/) (on Envoy Gateway) in your Project's location.

- **Provider keys stay in the platform.** Clients never see them; the gateway swaps the client's key
  for the provider's.
- **A key per client.** Every app, agent or stack gets a key of its own; removing a client revokes
  its key.
- **One place for models.** Clients pick a model by name; changing where a model runs (another
  provider, your own vLLM) changes no client.

Every GenAI stack has a gateway: its own (`<stack>-gateway`, changed through the stack), or a
shared one like this, which you create under **Building blocks → Model gateways**.

## Create one

```sh
kubectl -n team-payments create secret generic anthropic --from-literal=apiKey=sk-ant-...
```

```yaml
apiVersion: ai.cndev.nl/v1alpha1
kind: ModelGateway
metadata:
  name: llm
  namespace: team-payments
spec:
  clients:
    - name: support-bot          # a GenAI stack sharing it (gateway.ref: llm)
    - name: coding-agent
  models:
    - name: claude
      endpoint: https://api.anthropic.com/v1
      schema: Anthropic
      upstreamModel: claude-sonnet-5-5
      apiKeySecretRef:
        name: anthropic
    - name: llama
      endpoint: http://vllm.models.svc:8000/v1
      upstreamModel: meta-llama/Llama-3.1-8B-Instruct
```

## Call it

In the Project's location, with any OpenAI SDK:

```sh
OPENAI_BASE_URL=http://llm.team-payments.svc/v1
OPENAI_API_KEY=<the client's key>      # Secret llm-keys, key = the client's name
```

The **Clients** panel on the gateway's page shows the keys (with the `basis.gateway.credentials.read`
permission). Clients outside the location need a route there of their own; the gateway is internal
(ClusterIP) by design.

## Models

| Field | What |
|---|---|
| `name` | What clients send as `model` |
| `endpoint` | The provider's base URL; its path is the API prefix, e.g. `https://api.openai.com/v1` |
| `schema` | `OpenAI` (default; also every OpenAI-compatible server) or `Anthropic` |
| `upstreamModel` | The model's name at the provider, when it differs |
| `apiKeySecretRef` | Secret in the Project with the provider's key (`key`, default `apiKey`); none for an endpoint without auth |

HTTPS endpoints are verified against the system CAs.

## Settings

| Field | Default | What |
|---|---|---|
| `replicas` | `2` | Gateway replicas in the active site |
| `clients` | `[{name: apps}]` | Who may call it; a key each in Secret `<name>-keys` |
| `recovery.enabled`, `.replicas` | off, `1` | A standby in the Project's recovery location, with the same models and keys |
| `activeSite` | `protected` | The site with the full replicas (a stack sets it to where its database's primary is) |

## Troubleshooting

`kubectl describe modelgateway <name> -n <project>` shows `status.message` and the `GatewayReady`
condition.

| Symptom | Cause | Fix |
|---|---|---|
| `Waiting for Agent Router in the location(s)` for long | Envoy Gateway or Agent Router missing there | The location's **Agent Router** health check; the platform team installs it |
| `401` from the gateway | No or a wrong client key | The client's key from `<name>-keys`; is the client listed? |
| No route for a model | The request's `model` isn't one of `models[].name` | Use the name, not `upstreamModel` |
| Provider errors (`401` from the provider) | Wrong or missing provider key | The Secret in `apiKeySecretRef` |
| Refused: `... belongs to GenAIStack ...` | The gateway is a stack's own | Change the stack, or use a shared gateway |
