# Model servers

A `ModelServer` (`ai.cndev.nl/v1alpha1`) runs an open model on your Project's GPUs:
[vLLM](https://docs.vllm.ai/) run by [KServe](https://kserve.github.io/website/), in your Project's
location. Clients reach it through a [model gateway](model-gateways.md), like any other model.

- **Your model, your infrastructure.** Weights from Hugging Face, a volume or an image; prompts
  never leave the location. A self-hosted model passes the model residency policy of every
  classification that allows `self-hosted`.
- **Prefix-cache-aware routing.** [llm-d](https://llm-d.ai/)'s scheduler sends each request to the
  replica most likely to hold its prompt's prefix in its KV cache, weighed against the replicas'
  load. Long system prompts, RAG context and an agent's growing conversation skip most of their
  prefill.
- **Operated like the rest.** Metrics, alerts and a dashboard in the Project's Grafana; a standby in
  the recovery site if you want one.

## Create one

With a gated model (Llama, Gemma, ...), put a Hugging Face token in a Secret first:

```sh
kubectl -n team-payments create secret generic hf-token --from-literal=HF_TOKEN=hf_...
```

```yaml
apiVersion: ai.cndev.nl/v1alpha1
kind: ModelServer
metadata:
  name: llama
  namespace: team-payments
spec:
  model:
    uri: hf://meta-llama/Llama-3.1-8B-Instruct
    tokenSecretRef:
      name: hf-token
  replicas: 2
  resources:
    cpu: "8"
    memory: 32Gi
    gpus: 1
```

Then name it in a gateway's models:

```yaml
spec:
  models:
    - name: llama          # what the server serves: its spec.model.name, else its name
      server: llama
```

Clients call the gateway with `model: llama`. `kubectl get modelserver -n team-payments` shows the
served name and whether it's ready; loading a large model takes minutes.

## Where the weights come from

| `model.uri` | What | Note |
|---|---|---|
| `hf://<org>/<model>` | Hugging Face | Downloaded at every pod start; `tokenSecretRef` for gated and private models |
| `pvc://<claim>/<path>` | A PersistentVolumeClaim in the Project's namespace in the location | Fill it once (e.g. with a Job); fastest to start |
| `oci://<image>` | A modelcar: an OCI image with the weights | Cached by the node like any image |
| `s3://<bucket>/<path>` | An S3 bucket | Downloaded at every pod start |

## How the gateway routes to it

With `routing.prefixCacheAware` (the default), KServe runs llm-d's endpoint picker next to the
server, behind an `InferencePool` (`status.inferencePool`), and the gateway hands each request to
it. Agent Router has two limits there, so the gateway uses the server's Service instead (plain round
robin) for a model that:

- is named differently from what the server serves (the gateway then renames it)
- has `fallbacks`, or is another model's fallback

A server with `routing.prefixCacheAware: false` has no scheduler, and every gateway balances it round
robin. A gateway routes a self-hosted model only in the sites its server runs in.

Apps in the location can also call the server directly at `status.endpoint`, without a key and
without prefix-cache-aware routing; the gateway is the way in for everything else (keys, limits,
audit log, fallbacks).

## Settings

| Field | Default | What |
|---|---|---|
| `model.uri` | required | See [Where the weights come from](#where-the-weights-come-from) |
| `model.name` | the ModelServer's name | The served name: what clients send as `model` |
| `model.tokenSecretRef.name`, `.key` | none, `HF_TOKEN` | A Hugging Face token in the Project |
| `replicas` | `1` | vLLM replicas in the protected site; `0` stops the server and frees its GPUs |
| `resources.cpu`, `.memory` | `4`, `16Gi` | Per replica; memory is request and limit |
| `resources.gpus`, `.gpuResource` | `1`, `nvidia.com/gpu` | GPUs per replica; more than one shards the model over them (tensor parallel). `0` for CPU only |
| `image` | KServe's (llm-d's CUDA build) | Another vLLM image: another GPU vendor's, or `vllm/vllm-openai-cpu:<version>` with `gpus: 0` (give it at least 4Gi of memory, even for a small model, and `--enforce-eager`; it runs three processes) |
| `args` | none | Extra `vllm serve` flags, one per item, e.g. `--max-model-len=16384` |
| `routing.prefixCacheAware` | on | See [How the gateway routes to it](#how-the-gateway-routes-to-it) |
| `scheduling.nodeSelector`, `.tolerations` | none | GPU nodes, e.g. a toleration for their taint |
| `recovery.enabled`, `.replicas` | off, `1` | The same server in the recovery location; `0` keeps it defined but stopped |
| `alerts.waitingRequests`, `.kvCacheUsagePercent`, `.timeToFirstTokenSeconds`, `.disabled` | `10`, `95`, `10`, off | See [Load and latency](#load-and-latency) |

## Load and latency

Each server gets a dashboard in the project's Grafana (folder *Model servers*) with, per site:
- requests running and waiting for a slot
- KV cache use per replica, and the prefix cache hit rate
- time to first token, inter-token latency and request duration (p50, p95)
- tokens per second, finished requests and preemptions

The project's Prometheus alerts, in each site with replicas:

| Alert | When (default) |
|---|---|
| `BasisModelServerDown` | No replica up for 15 minutes |
| `BasisModelServerQueueing` | More than `waitingRequests` (10) requests wait for a slot for 10 minutes: add replicas |
| `BasisModelServerKVCacheFull` | A replica's KV cache is over `kvCacheUsagePercent` (95) full for 15 minutes: requests get preempted |
| `BasisModelServerSlowFirstToken` | 95% of requests wait longer than `timeToFirstTokenSeconds` (10) for the first token, for 15 minutes |

## Troubleshooting

`kubectl describe modelserver <name> -n <project>` shows `status.message`, each site's state and the
`ServerReady` condition.

| Symptom | Cause | Fix |
|---|---|---|
| `can't apply the LLMInferenceService ... (is KServe installed there?)` | No KServe in the location | The location's **KServe** health check; the platform team installs it |
| `MainWorkloadReady: 0/N nodes are available: Insufficient nvidia.com/gpu` | No free GPUs (or no GPU nodes) | Fewer replicas or GPUs; free GPUs elsewhere; `scheduling` for tainted GPU nodes |
| Waiting for long after the pods run | The model is downloading or loading | `kubectl logs` of the pod's `storage-initializer`, then `main`, in the location |
| `401`/`403` in the download | A gated model without access | `tokenSecretRef`, and accept the model's licence on Hugging Face |
| The gateway says `no ModelServer <name>` | A typo in the gateway's `server` | The ModelServer's name in the same Project |
| `404 model does not exist` through the gateway | The gateway's model name isn't the served name, and it went to the pool | Name the model as `status.model` |
