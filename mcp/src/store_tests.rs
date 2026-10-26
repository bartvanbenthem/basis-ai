//! The store's tests run against a real PostgreSQL with pgvector:
//!
//!     podman run -d -p 55432:5432 -e POSTGRES_USER=app -e POSTGRES_PASSWORD=test pgvector/pgvector:pg18
//!     BASIS_MCP_TEST_DATABASE_URL=postgres://app:test@127.0.0.1:55432/app cargo test
//!
//! Without the variable they're skipped.

use super::*;
use crate::config::{Client, MODE_TEXT, Memory, Retrieval, SCOPE_SHARED};
use crate::embed::BoxFuture;
use sqlx::Connection;
use sqlx::postgres::PgConnection;
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

/// A deterministic stand-in for a model: hashed bag of words, normalized,
/// so texts sharing words are close.
#[derive(Default)]
struct WordEmbedder {
    dims: usize,
    fail: AtomicBool,
    calls: AtomicI64,
}

fn word_embedder(dims: usize) -> Arc<WordEmbedder> {
    Arc::new(WordEmbedder { dims, ..Default::default() })
}

fn fnv32a(b: &[u8]) -> u32 {
    b.iter().fold(0x811c9dc5u32, |h, c| (h ^ *c as u32).wrapping_mul(0x01000193))
}

impl WordEmbedder {
    fn vectors(&self, texts: &[String]) -> Vec<Vec<f32>> {
        texts.iter().map(|text| {
            let mut v = vec![0f32; self.dims];
            for w in text.to_lowercase().split_whitespace() {
                v[fnv32a(w.trim_matches(|c| ".,:;!?".contains(c)).as_bytes()) as usize % self.dims] += 1.0;
            }
            let mut norm: f64 = v.iter().map(|f| (f * f) as f64).sum();
            if norm == 0.0 {
                v[0] = 1.0;
                norm = 1.0;
            }
            v.iter().map(|f| f / norm.sqrt() as f32).collect()
        }).collect()
    }
}

impl Embedder for WordEmbedder {
    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, std::result::Result<Vec<Vec<f32>>, String>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail.load(Ordering::SeqCst) {
                return Err("model down".into());
            }
            Ok(self.vectors(texts))
        })
    }
}

fn test_url() -> Option<String> {
    let url = std::env::var("BASIS_MCP_TEST_DATABASE_URL").ok().filter(|u| !u.is_empty());
    if url.is_none() {
        eprintln!("BASIS_MCP_TEST_DATABASE_URL not set: skipped");
    }
    url
}

/// A store whose tables live in a schema of its own, dropped when it goes.
struct TestStore {
    store: Store,
    schema: String,
}

impl std::ops::Deref for TestStore {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.store
    }
}

impl std::ops::DerefMut for TestStore {
    fn deref_mut(&mut self) -> &mut Store {
        &mut self.store
    }
}

impl TestStore {
    async fn drop_schema(&self) {
        let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {} CASCADE", quote(&self.schema))).execute(&self.pool).await;
    }

    async fn done(self) {
        self.drop_schema().await;
        self.store.close().await;
    }
}

async fn new_test_store(url: &str, schema: &str, edit: impl FnOnce(&mut Config), embed: Arc<dyn Embedder>) -> TestStore {
    let mut cfg = Config {
        server: "kb".into(),
        namespace: "demo".into(),
        retrieval: Retrieval { enabled: true, table: format!("{schema}.documents"), ..Default::default() },
        memory: Memory { enabled: true, table: format!("{schema}.memories"), ..Default::default() },
        embeddings: crate::config::Embeddings { model: "words".into(), ..Default::default() },
        clients: BTreeMap::from([("agent-a".into(), Client::default()), ("agent-b".into(), Client::default())]),
        ..Default::default()
    };
    edit(&mut cfg);
    if cfg.retrieval.table == format!("{schema}.documents") {
        cfg.retrieval.own = true;
    }
    cfg.defaults();
    cfg.validate().unwrap();
    let s = TestStore { store: Store::new(url, cfg, embed).unwrap(), schema: schema.into() };
    s.drop_schema().await;
    s
}

async fn must_prepare(s: &Store) {
    s.prepare().await.unwrap_or_else(|e| panic!("prepare: {e:#}"));
    assert_eq!(s.problem(), "", "problem after prepare");
}

fn doc(title: &str, source: &str, content: &str, meta: Value) -> Document {
    let Value::Object(metadata) = meta else { panic!("metadata is an object") };
    Document { title: title.into(), source: source.into(), content: content.into(), metadata, ..Default::default() }
}

fn filter(v: Value) -> Map<String, Value> {
    let Value::Object(m) = v else { panic!("a filter is an object") };
    m
}

#[tokio::test]
async fn hybrid_search() {
    let Some(url) = test_url() else { return };
    let e = word_embedder(64);
    let s = new_test_store(&url, "t_hybrid_search", |_| {}, e.clone()).await;
    must_prepare(&s).await;
    assert_eq!(s.dims(), 64);
    // Twice: the second time everything exists (another replica, a restart).
    must_prepare(&s).await;

    let docs = [
        doc("Refunds", "kb/refunds.md", "Customers get a refund within 14 days of purchase.", json!({"team": "support"})),
        doc("Shipping", "kb/shipping.md", "Orders ship from Amsterdam within two working days.", json!({"team": "logistics"})),
        doc("Returns", "kb/returns.md", "Return the product in its original box for a refund.", json!({"team": "support"})),
    ];
    for d in &docs {
        let (_, embedded) = s.add_document(d).await.unwrap();
        assert!(embedded, "add {}: not embedded", d.title);
    }

    let (hits, warning) = s.search("how do I get a refund", 2, &Map::new()).await.unwrap();
    assert_eq!(warning, "");
    assert!(hits.len() == 2 && hits[0].title == "Refunds", "hits {hits:?}, want Refunds first of 2");
    for h in &hits {
        assert!(h.score > 0.0 && !h.id.is_empty() && !h.source.is_empty() && h.metadata.contains_key("team"),
            "hit without score, id, source or metadata: {h:?}");
    }

    // Metadata filter.
    let (hits, _) = s.search("refund ship days", 5, &filter(json!({"team": "logistics"}))).await.unwrap();
    assert!(hits.len() == 1 && hits[0].title == "Shipping", "filtered hits {hits:?}");

    // Text alone still finds an exact term when the model is down.
    e.fail.store(true, Ordering::SeqCst);
    let (hits, warning) = s.search("Amsterdam", 3, &Map::new()).await.unwrap();
    assert!(warning.contains("full-text results only") && hits.len() == 1 && hits[0].title == "Shipping",
        "text fallback: {hits:?} {warning:?}");
    e.fail.store(false, Ordering::SeqCst);

    // Fetch and delete.
    let d = s.fetch(&hits[0].id).await.unwrap().expect("fetched");
    assert!(d.content == docs[1].content && !d.truncated, "fetch: {d:?}");
    assert_eq!(s.fetch("not-a-number").await.unwrap(), None, "fetch of a bad id");
    assert!(s.delete_document(&hits[0].id).await.unwrap(), "delete");
    assert!(!s.delete_document(&hits[0].id).await.unwrap(), "deleted twice");
    s.done().await;
}

#[tokio::test]
async fn snippet_and_indexes() {
    let Some(url) = test_url() else { return };
    let s = new_test_store(&url, "t_snippet_and_indexes", |c| c.retrieval.text_search_config = "english".into(), word_embedder(32)).await;
    must_prepare(&s).await;
    let long = "kubernetes operators reconcile state. ".repeat(100);
    s.add_document(&Document { title: "Operators".into(), content: long, ..Default::default() }).await.unwrap();
    let (hits, _) = s.search("operator reconciling", 3, &Map::new()).await.unwrap();
    assert!(hits.len() == 1 && hits[0].truncated && hits[0].content.len() == SNIPPET as usize, "hits {hits:?}");
    // The full-text index is the one the query's expression uses.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_indexes WHERE schemaname = $1 AND indexname IN \
        ('documents_fts_english', 'documents_embedding', 'memories_fts_english', 'memories_embedding')")
        .bind(&s.docs.schema_name).fetch_one(&s.pool).await.unwrap();
    assert_eq!(n, 4, "indexes");
    let mut tx = s.pool.begin().await.unwrap();
    sqlx::query("SET LOCAL enable_seqscan = off").execute(&mut *tx).await.unwrap();
    let plan: Vec<String> = sqlx::query_scalar(&format!("EXPLAIN SELECT 1 FROM {} d WHERE {} @@ websearch_to_tsquery('english', 'operator')",
        s.docs.name, s.docs.fts())).fetch_all(&mut *tx).await.unwrap();
    let plan = plan.join("\n");
    assert!(plan.contains("documents_fts_english"), "full-text query doesn't use the index:\n{plan}");
    tx.rollback().await.unwrap();
    s.done().await;
}

#[tokio::test]
async fn memory_scopes() {
    let Some(url) = test_url() else { return };
    let mut s = new_test_store(&url, "t_memory_scopes", |_| {}, word_embedder(64)).await;
    must_prepare(&s).await;

    let (id_a, _) = s.remember("agent-a", "The customer Acme prefers invoices in euros.", &["customer:acme".into(), "preference".into()]).await.unwrap();
    s.remember("agent-a", "Deploys happen on Tuesdays.", &[]).await.unwrap();
    s.remember("agent-b", "Acme's contact is Jo.", &["customer:acme".into()]).await.unwrap();

    let (got, _) = s.recall("agent-a", "which currency does acme want", 5, &[]).await.unwrap();
    assert!(!got.is_empty() && got[0].id == id_a && got[0].client.is_empty(), "recall: {got:?}");
    assert!(got.iter().all(|m| !m.content.contains("Jo")), "agent-a recalled agent-b's memory: {got:?}");
    // By tag, and the most recent without a query.
    let (got, _) = s.recall("agent-a", "", 5, &["preference".into()]).await.unwrap();
    assert!(got.len() == 1 && got[0].id == id_a, "by tag: {got:?}");
    let (got, _) = s.recall("agent-a", "", 1, &[]).await.unwrap();
    assert!(got.len() == 1 && got[0].content == "Deploys happen on Tuesdays.", "most recent: {got:?}");
    // agent-b can't forget agent-a's memory.
    assert!(!s.forget("agent-b", id_a).await.unwrap(), "agent-b forgot agent-a's memory");
    assert!(s.forget("agent-a", id_a).await.unwrap(), "forget");

    // Shared: everyone's, with who wrote it.
    s.cfg.memory.scope = SCOPE_SHARED.into();
    let (got, _) = s.recall("agent-a", "acme", 5, &[]).await.unwrap();
    assert!(!got.is_empty() && got[0].client == "agent-b" && got[0].content.contains("Jo"), "shared recall: {got:?}");
    s.done().await;
}

#[tokio::test]
async fn backfill_and_expire() {
    let Some(url) = test_url() else { return };
    let e = word_embedder(16);
    let s = new_test_store(&url, "t_backfill_and_expire", |c| c.memory.retention_days = 30, e.clone()).await;
    must_prepare(&s).await;

    e.fail.store(true, Ordering::SeqCst);
    let (_, embedded) = s.add_document(&Document { content: "stored while the model was down".into(), ..Default::default() }).await.unwrap();
    assert!(!embedded, "add: embedded");
    let (_, embedded) = s.remember("agent-a", "remembered while the model was down", &[]).await.unwrap();
    assert!(!embedded, "remember: embedded");
    assert!(s.backfill(10).await.is_err(), "backfill with the model down: want an error");
    e.fail.store(false, Ordering::SeqCst);
    assert_eq!(s.backfill(10).await.unwrap(), 2, "backfill");
    assert_eq!(s.backfill(10).await.unwrap(), 0, "second backfill");

    sqlx::query(&format!("UPDATE {} SET created_at = now() - interval '40 days'", s.mems.name)).execute(&s.pool).await.unwrap();
    s.remember("agent-a", "recent", &[]).await.unwrap();
    assert_eq!(s.expire().await.unwrap(), 1, "expire");
    s.done().await;
}

#[tokio::test]
async fn text_only() {
    let Some(url) = test_url() else { return };
    let e = word_embedder(8);
    let s = new_test_store(&url, "t_text_only", |c| {
        c.embeddings.model = String::new();
        c.retrieval.mode = MODE_TEXT.into();
    }, e.clone()).await;
    must_prepare(&s).await;
    let (_, embedded) = s.add_document(&Document { title: "Backups".into(), content: "Barman archives WAL to object storage.".into(),
        ..Default::default() }).await.unwrap();
    assert!(!embedded, "add: embedded without a model");
    let (hits, _) = s.search("barman", 3, &Map::new()).await.unwrap();
    assert_eq!(hits.len(), 1, "hits {hits:?}");
    s.remember("agent-a", "text only memory", &[]).await.unwrap();
    let (got, _) = s.recall("agent-a", "memory", 3, &[]).await.unwrap();
    assert_eq!(got.len(), 1, "recall {got:?}");
    assert_eq!(e.calls.load(Ordering::SeqCst), 0, "the embedder was called without a model");
    // No vector columns at all.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'embedding'")
        .bind(&s.docs.schema_name).fetch_one(&s.pool).await.unwrap();
    assert_eq!(n, 0, "embedding columns without a model");
    s.done().await;
}

#[tokio::test]
async fn own_table() {
    let Some(url) = test_url() else { return };
    let mut conn = PgConnection::connect(&url).await.unwrap();
    for stmt in [
        "DROP SCHEMA IF EXISTS kb_own CASCADE",
        "CREATE SCHEMA kb_own",
        "CREATE TABLE kb_own.chunks (chunk_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL, url text, attrs jsonb, vec vector(16))",
    ] {
        sqlx::query(stmt).execute(&mut conn).await.unwrap();
    }
    let e = word_embedder(16);
    let vecs = e.vectors(&["vacation days per year".into(), "office opening hours".into()]);
    for (i, body) in ["Employees get 25 vacation days per year.", "The office opens at 8."].iter().enumerate() {
        sqlx::query("INSERT INTO kb_own.chunks (body, url, attrs, vec) VALUES ($1, $2, $3, $4::vector)")
            .bind(body).bind(format!("https://wiki/{i}")).bind(Json(json!({"lang": "en"}))).bind(vector_literal(&vecs[i]))
            .execute(&mut conn).await.unwrap();
    }

    let s = new_test_store(&url, "t_own_table", |c| {
        c.retrieval.table = "kb_own.chunks".into();
        c.retrieval.columns = Columns { id: "chunk_id".into(), content: "body".into(), source: "url".into(), metadata: "attrs".into(),
            embedding: "vec".into(), ..Default::default() };
        c.memory.enabled = false;
    }, e.clone()).await;
    must_prepare(&s).await;
    let (hits, _) = s.search("how many vacation days", 1, &filter(json!({"lang": "en"}))).await.unwrap();
    assert!(hits.len() == 1 && hits[0].source == "https://wiki/0" && hits[0].title.is_empty(), "hits {hits:?}");
    let d = s.fetch(&hits[0].id).await.unwrap().expect("fetch by uuid");
    assert!(d.content.starts_with("Employees"), "fetch by uuid: {d:?}");
    assert_eq!(s.fetch("42").await.unwrap(), None, "fetch of a non-uuid");
    // Its table is read, never written: no indexes of the server's on it.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_indexes WHERE schemaname = 'kb_own' AND indexname <> 'chunks_pkey'")
        .fetch_one(&mut conn).await.unwrap();
    assert_eq!(n, 0, "indexes created on a table of your own");

    // A missing column is the store's problem, not a crash.
    let s2 = new_test_store(&url, "t_own_table_2", |c| {
        c.retrieval.table = "kb_own.chunks".into();
        c.retrieval.columns = Columns { id: "chunk_id".into(), content: "text".into(), ..Default::default() };
        c.retrieval.mode = MODE_TEXT.into();
        c.memory.enabled = false;
    }, e).await;
    assert!(s2.prepare().await.is_err() && s2.problem().contains("no column text"), "missing column: {:?}", s2.problem());
    s.done().await;
    s2.done().await;
    sqlx::query("DROP SCHEMA IF EXISTS kb_own CASCADE").execute(&mut conn).await.unwrap();
}

#[tokio::test]
async fn dimension_change() {
    let Some(url) = test_url() else { return };
    let mut s = new_test_store(&url, "t_dimension_change", |_| {}, word_embedder(16)).await;
    must_prepare(&s).await;
    // Another model with other dimensions, same tables.
    s.embed = word_embedder(24);
    let err = format!("{:#}", s.prepare().await.unwrap_err());
    assert!(err.contains("returns 24 dimensions, the tables hold 16"), "want a dimensions error, got {err}");
    s.done().await;
}

#[tokio::test]
async fn no_vector_extension() {
    let Some(url) = test_url() else { return };
    let mut conn = PgConnection::connect(&url).await.unwrap();
    // A database of its own without the extension.
    let _ = sqlx::query("DROP DATABASE IF EXISTS novector WITH (FORCE)").execute(&mut conn).await;
    if let Err(e) = sqlx::query("CREATE DATABASE novector").execute(&mut conn).await {
        eprintln!("can't create a database: {e}: skipped");
        return;
    }
    let mut cfg = Config {
        retrieval: Retrieval { enabled: true, ..Default::default() },
        memory: Memory { enabled: true, ..Default::default() },
        embeddings: crate::config::Embeddings { model: "words".into(), ..Default::default() },
        ..Default::default()
    };
    cfg.defaults();
    let other = format!("{}/novector", &url[..url.rfind('/').unwrap()]);
    let s = Store::new(&other, cfg, word_embedder(8)).unwrap();
    let err = format!("{:#}", s.prepare().await.unwrap_err());
    s.close().await;
    sqlx::query("DROP DATABASE IF EXISTS novector WITH (FORCE)").execute(&mut conn).await.unwrap();
    assert!(err.contains("no vector extension"), "want the vector extension error, got {err}");
}

#[tokio::test]
async fn read_only_replica() {
    let Some(url) = test_url() else { return };
    let s = new_test_store(&url, "t_read_only_replica", |_| {}, word_embedder(8)).await;
    must_prepare(&s).await;
    // As a standby site's database reports itself.
    s.set_read_only(true);
    let err = s.remember("agent-a", "x", &[]).await.unwrap_err();
    assert!(err.is::<ReadOnly>(), "remember on a replica: {err}");
    let err = s.add_document(&Document { content: "x".into(), ..Default::default() }).await.unwrap_err();
    assert!(err.is::<ReadOnly>(), "add on a replica: {err}");
    s.search("x", 1, &Map::new()).await.unwrap();
    assert_eq!(s.backfill(10).await.unwrap(), 0, "backfill on a replica");
    // It doesn't create tables, it waits for them.
    must_prepare(&s).await;
    s.done().await;
}

#[tokio::test]
async fn concurrent_prepare() {
    let Some(url) = test_url() else { return };
    // Replicas starting together: the advisory lock serializes their DDL.
    let s = new_test_store(&url, "t_concurrent_prepare", |_| {}, word_embedder(8)).await;
    let (a, b, c, d) = tokio::join!(s.prepare(), s.prepare(), s.prepare(), s.prepare());
    for r in [a, b, c, d] {
        r.unwrap();
    }
    s.done().await;
}
