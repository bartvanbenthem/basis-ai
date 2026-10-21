# Agents and MCP

Agents such as Claude Code and Codex can use the platform the way a person does: through its API,
within the same permissions. Two ways in:

- **MCP tools.** The portal serves the platform as MCP tools (Backstage's MCP actions).
- **The Kubernetes API.** Every BASIS object is a Kubernetes resource with a schema, admission
  rules that say why something is refused, and server-side dry runs.

Either way the platform's guardrails hold: schemas, admission policies, Project quotas and access,
deletion protection.

## MCP tools

| Tool | What |
|---|---|
| `basis:list-projects` | Projects and their locations |
| `basis:list-genai-stacks` | Stacks: health, active site, gateway, connection Secret |
| `basis:list-model-gateways` | Gateways: endpoint, models, clients |
| `basis:create-genai-stack` | Validates (default) or creates a stack |
| `basis:create-model-gateway` | Validates (default) or creates a gateway |

These are the action ids; MCP clients list them as tools. Next to them, the catalog's and the
software templates' tools.

- The create tools validate only, unless the agent passes `dryRun: false`, so an agent can show
  you the plan first.
- Every tool runs as you, with your `basis.*` permissions.
- No tool hands out credentials. An app mounts its stack's connection Secret; a person reads gateway
  keys in the portal.

Connect a client to the portal's MCP endpoint, e.g. Claude Code:

```sh
claude mcp add --transport http basis https://<portal>/api/mcp-actions/v1
```

The client signs in to the portal; see Backstage's
[MCP actions](https://backstage.io/docs/ai/mcp-actions) for tokens and client registration.

## The Kubernetes API

An agent with a kubeconfig for the control plane (your Project's `edit` role is enough for stacks,
gateways, databases and caches):

```sh
kubectl explain genaistack.spec                     # the fields, from the schema
kubectl apply --dry-run=server -f stack.yaml       # schema, rules and admission policies
kubectl get genaistack -n <project>                 # READY, and status.message when not
```

Refusals name the rule and what to do, e.g. *ModelGateway llm has no client support-bot; add it to
its spec.clients*, so an agent can correct itself.

## For models: llms.txt

[`llms.txt`](../llms.txt) summarises the APIs, their fields and the rules for an LLM's context: give
it to an agent before it writes manifests.
