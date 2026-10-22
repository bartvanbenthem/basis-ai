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

In the portal, **Building blocks → Model gateways → Create gateway**. For each model, choose
**Provider API key → Enter the key**: the portal writes it into a Secret in the project
(`<gateway>-key-<model>-<hash>`, removed with the gateway) and puts only the reference in the
manifest. Pick **A Secret of my own** to reference one you created, or **None** for an endpoint
without auth.

With kubectl, create the Secret yourself: the token goes after `apiKey=`; `apiKey` is the name it's
stored under, which the model's `apiKeySecretRef.key` names.

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
permission). The gateway is internal (ClusterIP) by default; for clients elsewhere, expose it.

## Expose it

For agents, tools and apps outside the Project's locations, `spec.expose` adds an HTTPS endpoint
next to the internal one:

```yaml
spec:
  expose:
    enabled: true
    hostname: llm.example.com            # the certificate's name; its DNS record is yours
    loadBalancerSourceRanges: [203.0.113.0/24]   # who reaches it at all; 0.0.0.0/0 for everyone
```

```sh
OPENAI_BASE_URL=https://llm.example.com/v1
OPENAI_API_KEY=<the client's key>
```

- Each site gets a Gateway `<name>-external` of its own on a LoadBalancer Service `<name>-external`,
  HTTPS only, with a certificate from cert-manager (the platform's ClusterIssuer `basis`, or
  `expose.issuer`). The internal endpoint and its plain HTTP stay in-cluster.
- Clients still need a key: the source ranges limit who can connect, the key who gets an answer.
- Point the hostname's DNS at the load balancer address on the gateway's page (`status.sites[].address`).
  With recovery each site has its own; after a switchover, point it at the new active site's.
- In the portal: **External access** on the gateway's form, or **Expose the gateway over HTTPS** on a
  stack's.

## Models

| Field | What |
|---|---|
| `name` | What clients send as `model` |
| `endpoint` | The provider's base URL; its path is the API prefix, e.g. `https://api.openai.com/v1` |
| `schema` | `OpenAI` (default; also every OpenAI-compatible server) or `Anthropic` |
| `upstreamModel` | The model's name at the provider, when it differs |
| `apiKeySecretRef` | Secret in the Project with the provider's key (`key`, default `apiKey`); none for an endpoint without auth |
| `fallbacks` | Other models of the gateway to try, in order, when this one fails (see [Resilience](#resilience)) |

HTTPS endpoints are verified against the system CAs.

## Resilience

When a provider fails (a 429 or 5xx, or a broken connection), the gateway retries with backoff. If
the model keeps failing, the gateway moves on to its `fallbacks`, giving each the same number of
attempts. A fallback gets the request under its own model name and with its own provider key, so a
hosted model can fall back to a self-hosted one, or to another provider:

```yaml
spec:
  models:
    - name: gpt-oss-120b
      endpoint: https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1
      upstreamModel: openai/gpt-oss-120b
      apiKeySecretRef: {name: stackit}
      fallbacks: [llama]            # tried when gpt-oss-120b keeps failing
    - name: llama
      endpoint: http://vllm.models.svc:8000/v1
  retry:
    attempts: 2                     # per model, the first included (default 2; 1 retries nothing)
    retryOn: [429, 500, 502, 503, 504]
    perTryTimeout: 60s
  rateLimit:                        # per minute for all clients, per site; past one, 429
    requestsPerMinute: 600
    tokensPerMinute: 200000
  clients:
    - name: support-bot
      requestsPerMinute: 60         # and per client
```

- **When retries stop:** a request is retried only before anything has gone back to the client,
  so never halfway through a streamed answer.
- **What rate limits need:** the per-minute caps, like the monthly ones, need the rate limit store
  in the location. Without it, everything else still works, but the caps aren't enforced.

## Latency and errors

Each gateway gets a dashboard in the project's Grafana (folder *Model gateways*; the **Dashboard**
button on the gateway's page) with these panels, per model and site:
- requests per second and the share that fails
- request duration (p50, p95)
- time to first token and time per output token (streamed requests)
- tokens per second
- retries and recovered requests
- responses to clients by status class, and rate-limited requests

The project's Prometheus alerts per model (thresholds in `alerts`):

| Alert | When (default) |
|---|---|
| `BasisGatewaySlow` | 95% of requests take longer than `latencySeconds` (60) for 15 minutes |
| `BasisGatewaySlowFirstToken` | 95% of streamed requests wait longer than `timeToFirstTokenSeconds` (10) for the first token, for 15 minutes |
| `BasisGatewayErrors` | More than `errorRatePercent` (5) of requests fail for 10 minutes |
| `BasisGatewayMetricsMissing` | No metrics from the gateway's proxies in a site for 10 minutes |

`alerts.disabled: true` turns them off for a gateway.

## Settings

| Field | Default | What |
|---|---|---|
| `replicas` | `2` | Gateway replicas in the active site |
| `clients` | `[{name: apps}]` | Who may call it; a key each in Secret `<name>-keys` |
| `recovery.enabled`, `.replicas` | off, `1` | A standby in the Project's recovery location, with the same models and keys |
| `activeSite` | `protected` | The site with the full replicas (a stack sets it to where its database's primary is) |
| `expose.enabled`, `.hostname`, `.loadBalancerSourceRanges` | off | HTTPS at `https://<hostname>/v1` for clients outside the location; both required when on |
| `expose.issuer`, `.annotations` | `basis`, none | The cert-manager ClusterIssuer; annotations on the LoadBalancer Service |
| `retry.attempts`, `.retryOn`, `.perTryTimeout` | `2`, `[429, 500, 502, 503, 504]`, none | See [Resilience](#resilience) |
| `rateLimit.requestsPerMinute`, `.tokensPerMinute` | none | Per-minute caps for all clients; per client too (`clients[]`) |
| `monthlyTokens` | none | A monthly token cap for all clients; per client too (`clients[]`) |
| `alerts.latencySeconds`, `.timeToFirstTokenSeconds`, `.errorRatePercent`, `.disabled` | `60`, `10`, `5`, off | See [Latency and errors](#latency-and-errors) |

## Troubleshooting

`kubectl describe modelgateway <name> -n <project>` shows `status.message` and the `GatewayReady`
condition.

| Symptom | Cause | Fix |
|---|---|---|
| `Waiting for Agent Router in the location(s)` for long | Envoy Gateway or Agent Router missing there | The location's **Agent Router** health check; the platform team installs it |
| `401` from the gateway | No or a wrong client key | The client's key from `<name>-keys`; is the client listed? |
| No route for a model | The request's `model` isn't one of `models[].name` | Use the name, not `upstreamModel` |
| Provider errors (`401` from the provider) | Wrong or missing provider key | The Secret in `apiKeySecretRef`; in the portal, **Enter the key** again |
| `cannot patch from referenced resource: data.<...>: no such field` | `apiKeySecretRef.key` names a key the Secret doesn't have (often the token itself pasted there) | The key's name, usually `apiKey`; the token goes in the Secret |
| Refused: `... belongs to GenAIStack ...` | The gateway is a stack's own | Change the stack, or use a shared gateway |
| `Waiting for the external endpoint: certificate <name>-tls ...` | The ClusterIssuer is missing or can't issue for the hostname | `kubectl describe certificate <name>-tls` in the location; the platform team sets up the issuer |
| `Waiting for the external endpoint: a LoadBalancer address ...` | The location has no load balancer for Services | The platform team (cloud load balancer, MetalLB, ...) |
| TLS errors from outside | The hostname doesn't point at the active site, or the client doesn't trust a private CA | DNS; with the default private CA, trust its certificate (ask the platform team) |
