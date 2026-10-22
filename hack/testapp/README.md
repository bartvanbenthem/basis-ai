# BASIS Lens (test app)

BASIS Lens is a photo library you search by meaning, running on one `GenAIStack`. It shows the stack
working the way a team's app would use it, and its smoke test checks the stack end to end.

- **Search by description:** "a dog on a beach at sunset", "something cozy", "black and white".
- **Search by image:** drop in a photo of your own.
- **More like this:** find photos similar to any photo in the library.
- **Ask about a photo:** "what's the mood?", "write an Instagram caption".

A vision model writes every photo's title, caption and tags when it is added.

| Stack part | What the app does with it |
|---|---|
| `ModelGateway` | Two models, both reached through the stack's endpoint with its client key. `qwen3-vl` (Qwen3-VL-235B) describes and answers questions about photos. `qwen3-vl-embedding` (Qwen3-VL-Embedding-8B) puts images and text in one vector space, at 1024 dimensions |
| `PostgresCluster` (vector) | The library, in schema `lens`: photos (display size and thumbnail), their descriptions, and their embeddings, with an HNSW index (pgvector) and a full-text index on the titles, tags and captions. A search merges the vector matches with the word matches (reciprocal rank fusion) |
| `ValkeyCache` (semantic) | Caches query embeddings, search results and answers about photos. Search results are cached exactly (same words) and semantically: a paraphrase ("sunset over the mountains" for "mountains at sunset") finds the earlier result through valkey-search KNN |
| connection Secret | The only configuration: `envFrom` a copy of the stack's `<stack>-connection` in the app's namespace |
| the Project's Prometheus | A PodMonitor in the stack's namespace, for the app's pods in its own, with the `lens_*` metrics: requests by kind and cache result, time per stage (describe, embed, retrieve, ...), tokens |
| recovery site | Deploy it in both sites. The standby's copy shows the replica's photos and refuses changes; `SITE` and `ACTIVE` come from the Secret |

Search results are cached under the library version, a row that every added or deleted photo bumps
in the same transaction. A new photo makes older results unreachable, and the version replicates
with the photos, so the recovery site's cache stays consistent with its own database.

## What the stack needs

**Models.** The two models on the stack's gateway, for example from STACKIT model serving. Each
entry goes in `spec.gateway.models`; this one reuses the chat model's key Secret:

```yaml
- name: qwen3-vl
  endpoint: https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1
  upstreamModel: Qwen/Qwen3-VL-235B-A22B-Instruct-FP8
  apiKeySecretRef: {name: newtest-key-gpt-oss-120b-2a8d818a, key: apiKey}
- name: qwen3-vl-embedding
  endpoint: https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1
  upstreamModel: Qwen/Qwen3-VL-Embedding-8B
  apiKeySecretRef: {name: newtest-key-gpt-oss-120b-2a8d818a, key: apiKey}
```

Images go to the embedding model in vLLM's chat-style `messages` field on `/v1/embeddings`; text
queries go in plain `input`. The gateway passes both through.

**function-basis v0.4.4 or later.** The gateway's 50Mi buffers on both sides:

- Without `BackendTrafficPolicy` (v0.4.3), embeddings fail with a 500.
- Without the HTTP/2 window (v0.4.4), any photo sent through the exposed HTTPS endpoint is
  refused with a 413, because over HTTP/2 a request is capped at Envoy's 64Ki stream window.

In-cluster calls use HTTP/1.1 and only need v0.4.3.

**Outbound internet.** The location needs it for the sample photos (Lorem Picsum, i.e. Unsplash
photos under the Unsplash license, credited to their photographers).

## Run it in the location, on a LoadBalancer

```sh
make push                     # the image: ghcr.io/bartvanbenthem/basis-lens:v0.1.0
make deploy                   # STACK=newtest NAMESPACE=multi-region APP_NAMESPACE=lens CONTEXT=protected
make deploy CONTEXT=recovery  # the standby site's copy, on a LoadBalancer of its own
make smoke                    # the end-to-end check below, on the protected site's LoadBalancer
```

`make deploy` prints the app's address, `http://<LoadBalancer IP>`. You can also get it later with
`make url`.

- **Its own namespace:** the app runs in `APP_NAMESPACE`, next to the stack's namespace rather than
  in it; `make deploy` creates it when missing. A Secret can only be used in its own namespace, so
  `make deploy` copies `<stack>-connection` there. The copy doesn't follow the stack: run
  `make deploy` again after a switchover or a key rotation, and the app restarts with the new copy.
  Several apps can share the stack this way, each from its own namespace.

To remove it:

```sh
make undeploy CONTEXT=recovery  # the app in a site, and its namespace if deploy created it; the photo library stays
make uninstall                  # undeploy, then drop schema lens on the active site (asks first)
```

Run `uninstall` against the active site: the standby's database is a read-only replica and follows.
Cached entries expire within `CACHE_TTL`.

- **Who can reach it:** the LoadBalancer serves plain HTTP, limited to `SOURCE_RANGES`. By default
  that's the CIDRs of the stack's exposed gateway, read from the control plane (the current kubectl
  context). Set it yourself, e.g. `SOURCE_RANGES=203.0.113.7/32,198.51.100.0/24`, to let others in.
  Plain HTTP is fine for a demo; put an ingress with TLS in front for anything more.
- **Image pulls:** the location must be able to pull the image. Make the ghcr.io package public, or
  add a pull secret.
- **First start:** the library is empty. **Load samples** adds 48 photos, each described and
  embedded as it arrives. Dropping photos on the left half of the page adds them; dropping one on
  the right half searches with it.

## Run it on this machine

```sh
make run                                  # DATABASE_URL, OPENAI_BASE_URL/KEY and the basis CA from local-env.sh
make smoke BASE_URL=http://localhost:8080
```

- **Endpoints:** this uses the stack's external endpoints (`retrieval.expose`, `gateway.expose`),
  so this machine must be in their `loadBalancerSourceRanges`.
- **No cache:** the cache is internal to the location, so the app runs without one.
- **Gateway older than v0.4.4:** set `GODEBUG=http2client=0`. HTTP/1.1 is limited by the 50Mi
  connection buffer instead of the 64Ki HTTP/2 stream window.

## The smoke test

[`smoke.sh`](smoke.sh) checks the whole stack through the app:

1. **Components:** the database, the cache (with valkey-search) and the gateway answer.
2. **Library:** it loads the sample photos if the library is small.
3. **Adding a photo:** it adds a generated photo, which gets a title and tags. The same bytes again
   are a duplicate.
4. **Search by image:** that photo finds itself first.
5. **Search by text:** a text search returns photos. The same words again are an exact cache hit,
   and a paraphrase is a semantic hit.
6. **More like this, and a question:** "more like this" works, and a question about a photo is
   answered. The same question again comes from the cache.
7. **Metrics and cleanup:** the app exports its metrics, and the generated photo is deleted again.

It exits non-zero on a failure, so it fits CI or a check after a switchover. Run it again after
setting `recovery.activeSite: recovery`, against the recovery site's copy.

## Configuration

Beyond the connection Secret: `VISION_MODEL`, `EMBED_MODEL`, `EMBED_DIM`, `RESULTS`,
`MIN_SIMILARITY`, `CACHE_TTL`, `SEMANTIC_MAX_DISTANCE`, `SEED_COUNT`, `OPENAI_CA_FILE`, `LISTEN`
(defaults and how they were measured in [`main.go`](main.go)).

The `embedding` column has a fixed dimension, so a different embedding model or `EMBED_DIM` needs a
fresh schema: `DROP SCHEMA lens CASCADE`.
