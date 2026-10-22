# Governance and cost

Every Project says what it is, who pays and what it may spend, and the platform acts on it: which
models its gateways may use, whether anything may open to the internet, a cost forecast against its
budget, token caps per gateway client, and when it expires.

## On the Project

| Field | Default | What it does |
|---|---|---|
| `classification` | `internal` | `public`, `internal` or `confidential`. Decides the models its gateways may use; in a `confidential` project nothing opens to `0.0.0.0/0` |
| `environment` | `production` | `production`, `staging`, `development` or `sandbox`. A label for reports and policies |
| `costCenter` | | Who pays, for showback |
| `budget.monthly` | | In the price catalog's currency (EUR). Alerts when the month's forecast passes 80% and 100% |
| `budget.monthlyTokens` | | Tokens through all the project's gateways; alerts like the budget |
| `expiresAt` | | The last day (`YYYY-MM-DD`). After it nothing new can be created in the project; what runs keeps running |

All of them are on the project form in the portal, under **Governance and cost**, and are set as
labels on the project's namespaces (`platform.cndev.nl/classification`, `/environment`,
`/cost-center`, `/expired`).

## Cost

The project page's **Cost** card and the *Cost* dashboard in the project's Grafana show:

- **The month's forecast**, at the last day's rate, against the budget.
- **What the last 7 days cost.**
- **A breakdown** by component (CPU, memory, storage, load balancers, tokens) and site.
- **Tokens and their cost** per model.

Everything is priced from what actually runs in the project's locations: the CPU and memory
requests of running pods, volume claims, LoadBalancer Services, and the tokens through its model
gateways. The prices come from the platform's catalog, the EnvironmentConfig `basis-prices`
(`api/apis/project/prices.yaml`), which the platform team keeps current. Without that catalog,
projects have no cost data.

## Models and residency

The platform's model catalog, the EnvironmentConfig `basis-models`
(`api/apis/modelgateway/models.yaml`), lists the model providers gateways may route to and where
each keeps the data:

- `self-hosted`: in the platform's own clusters.
- `eu`: a provider processing in the EU.
- `non-eu`: anywhere else.

Each classification allows some of these residencies. By default `confidential` allows
`self-hosted` and `eu` only.

Creating or changing a ModelGateway or GenAIStack whose models aren't allowed fails with a message
that names them. Ask the platform team to add a provider to the catalog.

## Token caps and keys per client

A ModelGateway (or a GenAIStack's own gateway) can cap tokens, input and output together, per
calendar month and per site:

```yaml
spec:
  monthlyTokens: 10000000          # the whole gateway
  clients:
    - name: support-bot
      owner: team-support          # who to ask about this key
      monthlyTokens: 2000000       # this client
      expiresAt: "2026-12-31"      # the key's last day; after it, revoked
```

- **Past a cap:** the gateway answers `429` until the month ends.
- **After a key's last day:** the key stops working, and setting a later date makes a new key.
- **In the portal:** the gateway form has these per client, under **Clients**.

## Audit trail of model calls

Each gateway logs every call: which client, which model, how many tokens, the result and the
duration, never the prompt or the answer. The project's **Audit logs** page shows these entries
as **Model gateways**, next to the Kubernetes events and the PostgreSQL audit records. The
**Audit logging** switch on a cluster or a GenAI stack's database turns on PostgreSQL's audit
records.
