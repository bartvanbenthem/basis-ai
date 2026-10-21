# Vector & RAG

The **Vector & RAG** profile makes a cluster ready for embeddings, retrieval-augmented generation
(RAG) and hybrid search. In the portal it's **New RAG cluster** in the navigation, or **Workload
profile → Vector & RAG** in the form.

## What the profile gives you

| | |
|---|---|
| PostgreSQL 18 | Needed for extensions mounted from images. |
| pgvector (`vector`) | The `vector`, `halfvec` and `sparsevec` types, and HNSW and IVFFlat indexes. |
| VectorChord (`vchord`) | `vchordrq` indexes for large collections: faster to build and smaller than HNSW. |
| pg_search (`pg_search`) | Full-text search with BM25 ranking (`bm25` indexes), for hybrid search. |
| Tuning | More `maintenance_work_mem` (~20% of the memory) and parallel workers, so vector indexes build in memory. |
| Metrics | Size of every vector and BM25 index, and the progress of index builds. |

VectorChord and pg_search are mounted from images (CloudNativePG image volume extensions); both
require `vector`, which the platform creates first. Licenses: VectorChord AGPLv3 or ELv2,
pg_search AGPLv3.

```yaml
apiVersion: postgres.cndev.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: rag-db
  namespace: team-ai
spec:
  profile: vector
  postgresVersion: 18
  size: m
  database:
    name: docs
    owner: docs
    extensions: [vector, vchord, pg_search]
  backup:
    enabled: true
```

## Pick a size

A vector index answers fast while it fits in memory. Compare the index sizes on the cluster's
dashboard (`cnpg_vector_index_size_bytes`) with the instance memory; as a rule of thumb, an HNSW index
of 1 million 1024-dimension `vector` embeddings takes about 4–8 GB, half that with `halfvec`.
**M** (8Gi) holds an index of about a million such embeddings; take **L** or **XL** beyond that, or
use `halfvec` or VectorChord to make the index smaller. Move up a size when the indexes outgrow it.

## Store embeddings

```sql
CREATE TABLE chunks (
  id        bigserial PRIMARY KEY,
  doc_id    bigint NOT NULL,
  content   text   NOT NULL,
  embedding vector(1024)          -- the dimension of your embedding model
);
```

## Index them

**HNSW (pgvector)**: good recall without tuning, up to a few million rows.

```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
```

**VectorChord**: for larger collections. `lists` is roughly the number of rows divided by 1000
(see the [VectorChord docs](https://docs.vectorchord.ai/)).

```sql
CREATE INDEX ON chunks USING vchordrq (embedding vector_cosine_ops) WITH (options = $$
[build.internal]
lists = [2000]
$$);
SET vchordrq.probes = 20;   -- per session: more probes, better recall, slower
```

Building an index on many rows takes a while; the dashboard shows its progress
(`cnpg_create_index_progress_*`). Use `CREATE INDEX CONCURRENTLY` on a table in use.

## Search

```sql
SELECT id, content
FROM chunks
ORDER BY embedding <=> $1      -- $1: the query's embedding; <=> is cosine distance
LIMIT 10;
```

With a filter (`WHERE doc_id = ...`), turn on iterative scans so the index keeps looking until it
has enough rows:

```sql
SET hnsw.iterative_scan = relaxed_order;
```

## Hybrid search

Keyword search catches exact terms (product names, error codes) that embeddings miss. Add a BM25
index and combine both rankings with reciprocal rank fusion:

```sql
CREATE INDEX chunks_bm25 ON chunks USING bm25 (id, content) WITH (key_field = 'id');

WITH semantic AS (
  SELECT id, rank() OVER (ORDER BY embedding <=> $1) AS r
  FROM chunks ORDER BY embedding <=> $1 LIMIT 20
), keyword AS (
  SELECT id, rank() OVER (ORDER BY paradedb.score(id) DESC) AS r
  FROM chunks WHERE content @@@ $2 ORDER BY paradedb.score(id) DESC LIMIT 20
)
SELECT id,
       coalesce(1.0 / (60 + s.r), 0) + coalesce(1.0 / (60 + k.r), 0) AS score
FROM semantic s FULL JOIN keyword k USING (id)
ORDER BY score DESC
LIMIT 10;
```

See the [pg_search docs](https://docs.paradedb.com/) for its query syntax.

## Read traffic

RAG mostly reads. Turn on the read-only pooler (`pooler.readOnly`) and send searches to
`<name>-pooler-ro`, so they run on the standbys and leave the primary for writes.

## Requirements

The Project's location must support image volumes (Kubernetes `ImageVolume`, containerd 2.1 or
later). The portal's location health shows it as **Image volumes**.
