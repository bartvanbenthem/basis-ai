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

HTTPS endpoints are verified against the system CAs.

## Settings

| Field | Default | What |
|---|---|---|
| `replicas` | `2` | Gateway replicas in the active site |
| `clients` | `[{name: apps}]` | Who may call it; a key each in Secret `<name>-keys` |
| `recovery.enabled`, `.replicas` | off, `1` | A standby in the Project's recovery location, with the same models and keys |
| `activeSite` | `protected` | The site with the full replicas (a stack sets it to where its database's primary is) |
| `expose.enabled`, `.hostname`, `.loadBalancerSourceRanges` | off | HTTPS at `https://<hostname>/v1` for clients outside the location; both required when on |
| `expose.issuer`, `.annotations` | `basis`, none | The cert-manager ClusterIssuer; annotations on the LoadBalancer Service |

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
