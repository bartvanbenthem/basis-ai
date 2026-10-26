//! The documents and memories in PostgreSQL.

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::postgres::{PgArguments, PgConnectOptions, PgPool, PgPoolOptions, PgRow};
use sqlx::types::Json;
use sqlx::{Arguments, Row};
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::config::{Columns, Config, MODE_TEXT, MODE_VECTOR, SCOPE_CLIENT, SCOPE_SHARED};
use crate::embed::Embedder;

/// One search hit or fetched document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Document {
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub metadata: Map<String, Value>,
    /// Higher is better (reciprocal rank fusion, or one ranking's).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub score: f64,
    /// Content was cut for the hit list; fetch has all of it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// One memory.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: i64,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub score: f64,
}

fn is_zero(f: &f64) -> bool {
    *f == 0.0
}

/// The database here is a replica (a standby site's).
#[derive(Debug)]
pub struct ReadOnly;

impl std::fmt::Display for ReadOnly {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("this site's database is a read-only replica (the standby site); writes go to the active site")
    }
}

impl std::error::Error for ReadOnly {}

/// How much of a document's content a search hit carries.
pub const SNIPPET: i64 = 1500;

/// How many rows each ranking contributes before fusion, per hit wanted.
const CANDIDATES: i64 = 4;

/// Reciprocal rank fusion's constant: a hit's score is the sum over
/// rankings of 1/(RRF_K + rank).
const RRF_K: i64 = 60;

/// Serializes the replicas' DDL (pg_advisory_lock): "basis".
const LOCK_ID: i64 = 0x6261736973;

/// A documents or memories table as the SQL refers to it, its identifiers
/// quoted, its columns prefixed with the alias d.
#[derive(Debug, Clone, Default)]
pub(crate) struct Table {
    /// Quoted schema.table.
    pub name: String,
    /// d."col", or "" for none.
    pub id: String,
    pub content: String,
    pub title: String,
    pub source: String,
    pub metadata: String,
    pub embed: String,
    /// regconfig literal.
    pub text_config: String,
    // Unquoted, for the catalog and index names.
    pub schema_name: String,
    pub table_name: String,
    pub embed_col: String,
    pub cfg_id: String,
    pub title_col: String,
    pub content_col: String,
}

pub(crate) fn quote(id: &str) -> String {
    format!("\"{}\"", id.replace('"', "\"\""))
}

impl Table {
    fn new(qualified: &str, cols: &Columns, text_config: &str) -> Table {
        let (schema, name) = qualified.split_once('.').unwrap_or((qualified, ""));
        let col = |c: &str| if c.is_empty() { String::new() } else { format!("d.{}", quote(c)) };
        Table {
            name: format!("{}.{}", quote(schema), quote(name)),
            id: col(&cols.id),
            content: col(&cols.content),
            title: col(&cols.title),
            source: col(&cols.source),
            metadata: col(&cols.metadata),
            embed: col(&cols.embedding),
            text_config: format!("'{text_config}'::regconfig"),
            schema_name: schema.into(),
            table_name: name.into(),
            embed_col: cols.embedding.clone(),
            cfg_id: text_config.into(),
            title_col: cols.title.clone(),
            content_col: cols.content.clone(),
        }
    }

    /// The full-text vector of a row (alias d): title and content.
    pub fn fts(&self) -> String {
        self.fts_of("d.")
    }

    /// fts with the columns qualified by prefix: "" for an index
    /// expression, which the planner matches to the query's whatever the alias.
    fn fts_of(&self, prefix: &str) -> String {
        let content = format!("{prefix}{}", quote(&self.content_col));
        if !self.title_col.is_empty() {
            return format!("to_tsvector({}, coalesce({prefix}{}, '') || ' ' || coalesce({content}, ''))",
                self.text_config, quote(&self.title_col));
        }
        format!("to_tsvector({}, coalesce({content}, ''))", self.text_config)
    }
}

#[derive(Default)]
struct State {
    /// Why the store isn't ready, "" when it is.
    problem: String,
    /// Dimensions of the vectors in the tables; 0 without embeddings.
    dims: usize,
    /// The documents' id column type, for $n::type (fetch).
    doc_id: String,
    recovery_at: Option<Instant>,
    in_recovery: bool,
}

pub struct Store {
    pub(crate) pool: PgPool,
    pub(crate) cfg: Config,
    pub(crate) embed: Arc<dyn Embedder>,
    pub(crate) docs: Table,
    pub(crate) mems: Table,
    state: Mutex<State>,
}

/// Numbered query parameters.
#[derive(Default)]
struct Args {
    args: PgArguments,
    n: usize,
}

impl Args {
    fn add<'q, T>(&mut self, v: T) -> String
    where
        T: sqlx::Encode<'q, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + 'q,
    {
        self.args.add(v).expect("encoding a query parameter");
        self.n += 1;
        format!("${}", self.n)
    }
}

pub(crate) fn vector_literal(v: &[f32]) -> String {
    let parts: Vec<String> = v.iter().map(f32::to_string).collect();
    format!("[{}]", parts.join(","))
}

/// The CTE "h" (id, score) of t's rows matching where, best first: by
/// vector distance to vec, by full-text rank of query, or both fused by
/// reciprocal rank. vec None leaves the vector ranking out, query "" the
/// text one.
fn ranked(t: &Table, a: &mut Args, query: &str, vec: Option<&[f32]>, limit: i64, mut where_: &str) -> String {
    if where_.is_empty() {
        where_ = "true";
    }
    let mut ctes = vec![];
    let mut parts = vec![];
    let n = a.add(limit);
    if let Some(vec) = vec.filter(|_| !t.embed.is_empty()) {
        ctes.push(format!(
            "v AS (SELECT id, row_number() OVER (ORDER BY dist) AS r FROM (\n  SELECT {} AS id, {} <=> {}::vector AS dist FROM {} d WHERE {} IS NOT NULL AND {where_} ORDER BY dist LIMIT {n}) s)",
            t.id, t.embed, a.add(vector_literal(vec)), t.name, t.embed));
        parts.push("v");
    }
    if !query.trim().is_empty() {
        ctes.push(format!(
            "f AS (SELECT id, row_number() OVER (ORDER BY rank DESC) AS r FROM (\n  SELECT {} AS id, ts_rank_cd({}, q) AS rank FROM {} d, websearch_to_tsquery({}, {}) q WHERE {} @@ q AND {where_} ORDER BY rank DESC LIMIT {n}) s)",
            t.id, t.fts(), t.name, t.text_config, a.add(query.to_string()), t.fts()));
        parts.push("f");
    }
    let h = match parts.len() {
        0 => return String::new(),
        1 => format!("h AS (SELECT id, 1.0 / ({RRF_K} + r) AS score FROM {})", parts[0]),
        _ => format!("h AS (SELECT coalesce(v.id, f.id) AS id, coalesce(1.0 / ({RRF_K} + v.r), 0) + coalesce(1.0 / ({RRF_K} + f.r), 0) AS score\n  FROM v FULL JOIN f ON v.id = f.id)"),
    };
    ctes.push(h);
    format!("WITH {}", ctes.join(",\n"))
}

static SQL_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9 _]*(\([0-9, ]+\))?$").unwrap());

fn or_null(expr: &str, typ: &str) -> String {
    if expr.is_empty() { format!("NULL::{typ}") } else { expr.to_string() }
}

fn jsonb_of(expr: &str) -> String {
    if expr.is_empty() { String::new() } else { format!("{expr}::jsonb") }
}

fn nullable(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_string())
}

fn metadata(row: &PgRow, i: usize) -> Result<Map<String, Value>> {
    let m: Option<Json<Value>> = row.try_get(i)?;
    Ok(match m {
        Some(Json(Value::Object(m))) => m,
        _ => Map::new(),
    })
}

impl Store {
    /// Connects (lazily); prepare readies the tables.
    pub fn new(url: &str, cfg: Config, embed: Arc<dyn Embedder>) -> Result<Store> {
        let opts = PgConnectOptions::from_str(url).context("DATABASE_URL")?.application_name("basis-mcp");
        let pool = PgPoolOptions::new().max_connections(10).acquire_timeout(Duration::from_secs(10)).connect_lazy_with(opts);
        let mut docs = Table::new(&cfg.retrieval.table, &cfg.retrieval.columns, &cfg.retrieval.text_search_config);
        let mut mems = Table::new(&cfg.memory.table,
            &Columns { id: "id".into(), content: "content".into(), embedding: "embedding".into(), ..Default::default() },
            &cfg.retrieval.text_search_config);
        if !cfg.embeds() {
            mems.embed.clear();
            mems.embed_col.clear();
            if cfg.retrieval.own {
                docs.embed.clear();
                docs.embed_col.clear();
            }
        }
        let state = State { problem: "not prepared yet".into(), ..Default::default() };
        Ok(Store { pool, cfg, embed, docs, mems, state: Mutex::new(state) })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    /// Why the store can't serve yet, "" once it can.
    pub fn problem(&self) -> String {
        self.state.lock().unwrap().problem.clone()
    }

    /// The embeddings' dimensions, 0 without.
    pub fn dims(&self) -> usize {
        self.state.lock().unwrap().dims
    }

    /// The database answers.
    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    /// Checks the database and creates the server's own tables and indexes
    /// (on the primary; a replica gets them through replication). Called
    /// until it succeeds; its error is also problem.
    pub async fn prepare(&self) -> Result<()> {
        let out = self.try_prepare().await;
        self.state.lock().unwrap().problem = match &out {
            Ok(()) => String::new(),
            Err(e) => format!("{e:#}"),
        };
        out
    }

    async fn try_prepare(&self) -> Result<()> {
        self.ping().await.context("can't reach the database")?;
        let cfg = &self.cfg;
        let needs_vector = cfg.embeds() && (cfg.memory.enabled || (cfg.retrieval.enabled && !self.docs.embed.is_empty()));
        if needs_vector {
            let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')")
                .fetch_one(&self.pool).await?;
            if !ok {
                bail!("the database has no vector extension: add vector to the PostgresCluster's database.extensions (a GenAIStack has it)");
            }
        }
        let replica = self.read_only().await?;

        // The vectors' dimensions: the existing columns', else the model's.
        let mut dims = 0;
        if needs_vector {
            for t in self.vector_tables() {
                let d = self.column_dims(&t).await?;
                if d > 0 && dims > 0 && d != dims {
                    bail!("{}.{} has {d} dimensions, another table {dims}: one embeddings model per server", t.schema_name, t.table_name);
                }
                if d > 0 {
                    dims = d;
                }
            }
            let probe = self.embed.embed(&["dimensions".into()]).await
                .map_err(|e| anyhow!("embeddings model {}: {e}", cfg.embeddings.model))?;
            let got = probe.first().map_or(0, Vec::len);
            if dims == 0 {
                dims = got;
            } else if got != dims {
                bail!("embeddings model {} returns {got} dimensions, the tables hold {dims}: keep the model, or let the server re-embed into new tables (another retrieval.table / memory.table)",
                    cfg.embeddings.model);
            }
        }

        if !replica {
            self.create_tables(dims).await?;
        }
        if cfg.retrieval.enabled {
            self.check_documents(replica).await?;
        }
        if cfg.memory.enabled && replica {
            self.exists(&self.mems).await.map_err(|e| anyhow!("{e} (waiting for the primary to create it)"))?;
        }
        self.state.lock().unwrap().dims = dims;
        Ok(())
    }

    /// The tables with an embedding column the server writes or reads.
    fn vector_tables(&self) -> Vec<Table> {
        let mut out = vec![];
        if self.cfg.retrieval.enabled && !self.docs.embed.is_empty() {
            out.push(self.docs.clone());
        }
        if self.cfg.memory.enabled {
            out.push(self.mems.clone());
        }
        out
    }

    /// The dimensions of t's embedding column, 0 if it (or t) doesn't exist yet.
    async fn column_dims(&self, t: &Table) -> Result<usize> {
        let typmod: Option<i32> = sqlx::query_scalar(
            "SELECT a.atttypmod FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 AND NOT a.attisdropped")
            .bind(&t.schema_name).bind(&t.table_name).bind(&t.embed_col)
            .fetch_optional(&self.pool).await?;
        match typmod {
            None => Ok(0),
            // vector(n) keeps n as its type modifier; a vector without one can't be indexed.
            Some(m) if m <= 0 => bail!("{}.{}.{} is a vector without dimensions; declare it vector(n)", t.schema_name, t.table_name, t.embed_col),
            Some(m) => Ok(m as usize),
        }
    }

    async fn create_tables(&self, dims: usize) -> Result<()> {
        let stmts = self.table_statements(dims);
        // The lock is the session's, taken before the DDL's transaction: a
        // transaction that waited for it inside would check IF NOT EXISTS
        // against a catalog from before the previous holder committed.
        let mut conn = self.pool.acquire().await?;
        sqlx::query("SELECT pg_advisory_lock($1)").bind(LOCK_ID).execute(&mut *conn).await?;
        let created = Self::run_ddl(&mut conn, &stmts).await;
        if sqlx::query("SELECT pg_advisory_unlock($1)").bind(LOCK_ID).execute(&mut *conn).await.is_err() {
            // Closing the connection releases the lock.
            conn.close_on_drop();
        }
        created
    }

    async fn run_ddl(conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>, stmts: &[String]) -> Result<()> {
        let mut tx = sqlx::Connection::begin(&mut **conn).await?;
        for stmt in stmts {
            sqlx::query(stmt).persistent(false).execute(&mut *tx).await.context("creating the server's tables")?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// The DDL of the server's own tables and indexes.
    fn table_statements(&self, dims: usize) -> Vec<String> {
        let vector = |t: &Table| {
            if t.embed.is_empty() { String::new() } else { format!(",\n  {} vector({dims})", quote(&t.embed_col)) }
        };
        let mut stmts = vec![];
        let add_indexes = |stmts: &mut Vec<String>, t: &Table, extra: String| {
            stmts.push(format!("CREATE INDEX IF NOT EXISTS {} ON {} USING gin (({}))",
                quote(&format!("{}_fts_{}", t.table_name, t.cfg_id)), t.name, t.fts_of("")));
            if !t.embed.is_empty() {
                // A vector column takes the embedding later, too (embeddings.model set afterwards).
                stmts.push(format!("ALTER TABLE {} ADD COLUMN IF NOT EXISTS {} vector({dims})", t.name, quote(&t.embed_col)));
                // HNSW indexes vectors up to 2000 dimensions; bigger ones are searched without.
                if dims <= 2000 {
                    stmts.push(format!("CREATE INDEX IF NOT EXISTS {} ON {} USING hnsw ({} vector_cosine_ops)",
                        quote(&format!("{}_embedding", t.table_name)), t.name, quote(&t.embed_col)));
                }
            }
            stmts.push(extra);
        };
        if self.cfg.retrieval.enabled && self.cfg.retrieval.own {
            let t = &self.docs;
            stmts.push(format!("CREATE SCHEMA IF NOT EXISTS {}", quote(&t.schema_name)));
            stmts.push(format!("CREATE TABLE IF NOT EXISTS {} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text,
  source text,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{{}}',
  created_at timestamptz NOT NULL DEFAULT now(){}
)", t.name, vector(t)));
            add_indexes(&mut stmts, t, format!("CREATE INDEX IF NOT EXISTS {} ON {} USING gin (metadata jsonb_path_ops)",
                quote(&format!("{}_metadata", t.table_name)), t.name));
        }
        if self.cfg.memory.enabled {
            let t = &self.mems;
            stmts.push(format!("CREATE SCHEMA IF NOT EXISTS {}", quote(&t.schema_name)));
            stmts.push(format!("CREATE TABLE IF NOT EXISTS {} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client text NOT NULL,
  content text NOT NULL,
  tags text[] NOT NULL DEFAULT '{{}}',
  created_at timestamptz NOT NULL DEFAULT now(){}
)", t.name, vector(t)));
            add_indexes(&mut stmts, t, format!("CREATE INDEX IF NOT EXISTS {} ON {} (client, created_at DESC)",
                quote(&format!("{}_client", t.table_name)), t.name));
        }
        stmts
    }

    async fn exists(&self, t: &Table) -> Result<()> {
        let ok: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(format!("{}.{}", t.schema_name, t.table_name))
            .fetch_one(&self.pool).await?;
        if !ok {
            bail!("no table {}.{}", t.schema_name, t.table_name);
        }
        Ok(())
    }

    /// The documents table is there with the columns it's read through, and
    /// the id column's type is known (fetch casts to it).
    async fn check_documents(&self, replica: bool) -> Result<()> {
        let t = &self.docs;
        if let Err(e) = self.exists(t).await {
            if replica && self.cfg.retrieval.own {
                bail!("{e} (waiting for the primary to create it)");
            }
            return Err(e);
        }
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped")
            .bind(&t.schema_name).bind(&t.table_name)
            .fetch_all(&self.pool).await?;
        let types: std::collections::HashMap<String, String> = rows.into_iter().collect();
        let typ = |c: &str| types.get(c).map(String::as_str).unwrap_or("");
        let cols = &self.cfg.retrieval.columns;
        for (field, col) in [("id", &cols.id), ("content", &cols.content), ("title", &cols.title),
            ("source", &cols.source), ("metadata", &cols.metadata), ("embedding", &t.embed_col)]
        {
            if !col.is_empty() && typ(col).is_empty() {
                bail!("{}.{} has no column {col} (retrieval.columns.{field})", t.schema_name, t.table_name);
            }
        }
        let m = &cols.metadata;
        if !m.is_empty() && typ(m) != "jsonb" && typ(m) != "json" {
            bail!("{}.{}.{m} is {}; metadata must be jsonb or json", t.schema_name, t.table_name, typ(m));
        }
        let id_type = typ(&cols.id);
        let id_type = if SQL_TYPE.is_match(id_type) { id_type } else { "text" };
        self.state.lock().unwrap().doc_id = id_type.into();
        Ok(())
    }

    /// The database is a replica, checked at most every 10s.
    async fn read_only(&self) -> Result<bool> {
        {
            let st = self.state.lock().unwrap();
            if st.recovery_at.is_some_and(|at| at.elapsed() < Duration::from_secs(10)) {
                return Ok(st.in_recovery);
            }
        }
        let ro: bool = sqlx::query_scalar("SELECT pg_is_in_recovery()").fetch_one(&self.pool).await?;
        let mut st = self.state.lock().unwrap();
        st.recovery_at = Some(Instant::now());
        st.in_recovery = ro;
        Ok(ro)
    }

    /// Pretends the database is (or isn't) a replica for a while, as a
    /// standby site's reports itself.
    #[cfg(test)]
    pub(crate) fn set_read_only(&self, ro: bool) {
        let mut st = self.state.lock().unwrap();
        st.recovery_at = Some(Instant::now() + Duration::from_secs(3600));
        st.in_recovery = ro;
    }

    async fn writable(&self) -> Result<()> {
        if self.read_only().await? {
            return Err(ReadOnly.into());
        }
        Ok(())
    }

    /// Embeds a query for a vector ranking: None (and a warning) when the
    /// mode leaves it out or the model can't be reached, then text alone ranks.
    async fn query_vector(&self, t: &Table, query: &str) -> Result<(Option<Vec<f32>>, String)> {
        let mode = &self.cfg.retrieval.mode;
        if mode == MODE_TEXT || t.embed.is_empty() || query.trim().is_empty() {
            return Ok((None, String::new()));
        }
        match self.embed.embed(&[query.to_string()]).await {
            Err(e) if mode == MODE_VECTOR => Err(anyhow!(e)),
            Err(e) => Ok((None, format!("embeddings unavailable, full-text results only: {e}"))),
            Ok(mut vecs) => {
                let v = vecs.swap_remove(0);
                let d = self.dims();
                if d > 0 && v.len() != d {
                    bail!("the embeddings model returns {} dimensions, the table holds {d}", v.len());
                }
                Ok((Some(v), String::new()))
            }
        }
    }

    fn text_query<'a>(&self, query: &'a str) -> &'a str {
        if self.cfg.retrieval.mode == MODE_VECTOR { "" } else { query }
    }

    /// Ranks documents for query, those whose metadata contains filter.
    pub async fn search(&self, query: &str, k: i64, filter: &Map<String, Value>) -> Result<(Vec<Document>, String)> {
        let t = &self.docs;
        let (vec, warning) = self.query_vector(t, query).await?;
        let mut a = Args::default();
        let mut where_ = String::new();
        if !filter.is_empty() {
            if t.metadata.is_empty() {
                bail!("this documents table has no metadata column to filter on");
            }
            where_ = format!("{}::jsonb @> {}::jsonb", t.metadata, a.add(Value::Object(filter.clone()).to_string()));
        }
        let with = ranked(t, &mut a, self.text_query(query), vec.as_deref(), k * CANDIDATES, &where_);
        if with.is_empty() {
            return Ok((vec![], warning));
        }
        let sql = format!(
            "{with}\nSELECT {}::text, {}, {}, left({}, {SNIPPET}), length({}) > {SNIPPET}, {}, h.score::float8 FROM h JOIN {} d ON {} = h.id ORDER BY h.score DESC LIMIT {}",
            t.id, or_null(&t.title, "text"), or_null(&t.source, "text"), t.content, t.content,
            or_null(&jsonb_of(&t.metadata), "jsonb"), t.name, t.id, a.add(k));
        let rows = sqlx::query_with(&sql, a.args).fetch_all(&self.pool).await?;
        let docs = rows.iter().map(|row| -> Result<Document> {
            Ok(Document {
                id: row.try_get(0)?,
                title: row.try_get::<Option<String>, _>(1)?.unwrap_or_default(),
                source: row.try_get::<Option<String>, _>(2)?.unwrap_or_default(),
                content: row.try_get(3)?,
                truncated: row.try_get(4)?,
                metadata: metadata(row, 5)?,
                score: row.try_get(6)?,
            })
        }).collect::<Result<_>>()?;
        Ok((docs, warning))
    }

    /// One document, all of it; None if there is none.
    pub async fn fetch(&self, id: &str) -> Result<Option<Document>> {
        let t = &self.docs;
        let id_type = {
            let st = self.state.lock().unwrap();
            if st.doc_id.is_empty() { "bigint".to_string() } else { st.doc_id.clone() }
        };
        let sql = format!("SELECT {}::text, {}, {}, {}, {} FROM {} d WHERE {} = $1::{id_type}",
            t.id, or_null(&t.title, "text"), or_null(&t.source, "text"), t.content,
            or_null(&jsonb_of(&t.metadata), "jsonb"), t.name, t.id);
        let row = match sqlx::query(&sql).bind(id).fetch_optional(&self.pool).await {
            Ok(row) => row,
            // Not an id of the column's type: there's no such document.
            Err(e) if e.to_string().contains("invalid input syntax") => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let Some(row) = row else { return Ok(None) };
        Ok(Some(Document {
            id: row.try_get(0)?,
            title: row.try_get::<Option<String>, _>(1)?.unwrap_or_default(),
            source: row.try_get::<Option<String>, _>(2)?.unwrap_or_default(),
            content: row.try_get(3)?,
            metadata: metadata(&row, 4)?,
            ..Default::default()
        }))
    }

    /// Stores a document with its embedding; embedded false when the model
    /// couldn't be reached (the backfill embeds it later).
    pub async fn add_document(&self, d: &Document) -> Result<(String, bool)> {
        self.writable().await?;
        let vec = self.try_embed(&self.docs, format!("{}\n{}", d.title, d.content).trim()).await;
        let mut a = Args::default();
        let mut cols = vec!["title".to_string(), "source".into(), "content".into(), "metadata".into()];
        let mut vals = vec![a.add(nullable(&d.title)), a.add(nullable(&d.source)), a.add(d.content.clone()),
            format!("{}::jsonb", a.add(Json(Value::Object(d.metadata.clone()))))];
        if let Some(v) = &vec {
            cols.push(quote(&self.docs.embed_col));
            vals.push(format!("{}::vector", a.add(vector_literal(v))));
        }
        let sql = format!("INSERT INTO {} ({}) VALUES ({}) RETURNING id", self.docs.name, cols.join(", "), vals.join(", "));
        let id: i64 = sqlx::query_scalar_with(&sql, a.args).fetch_one(&self.pool).await?;
        Ok((id.to_string(), vec.is_some()))
    }

    /// Removes a document; false if there was none.
    pub async fn delete_document(&self, id: &str) -> Result<bool> {
        self.writable().await?;
        let Ok(n) = id.parse::<i64>() else { return Ok(false) };
        let res = sqlx::query(&format!("DELETE FROM {} WHERE id = $1", self.docs.name)).bind(n).execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }

    /// The where clause limiting memories to client's.
    fn memory_scope(&self, a: &mut Args, client: &str) -> String {
        if self.cfg.memory.scope == SCOPE_SHARED {
            return String::new();
        }
        format!("d.client = {}", a.add(client.to_string()))
    }

    /// Stores a memory of client's.
    pub async fn remember(&self, client: &str, content: &str, tags: &[String]) -> Result<(i64, bool)> {
        self.writable().await?;
        let vec = self.try_embed(&self.mems, content).await;
        let mut a = Args::default();
        let mut cols = vec!["client", "content", "tags"];
        let mut vals = vec![a.add(client.to_string()), a.add(content.to_string()), a.add(tags.to_vec())];
        if let Some(v) = &vec {
            cols.push("embedding");
            vals.push(format!("{}::vector", a.add(vector_literal(v))));
        }
        let sql = format!("INSERT INTO {} ({}) VALUES ({}) RETURNING id", self.mems.name, cols.join(", "), vals.join(", "));
        let id: i64 = sqlx::query_scalar_with(&sql, a.args).fetch_one(&self.pool).await?;
        Ok((id, vec.is_some()))
    }

    /// client's memories most like query, those with any of tags; with no
    /// query the most recent.
    pub async fn recall(&self, client: &str, query: &str, k: i64, tags: &[String]) -> Result<(Vec<MemoryItem>, String)> {
        let t = &self.mems;
        let mut a = Args::default();
        let mut conds = vec![];
        let scope = self.memory_scope(&mut a, client);
        if !scope.is_empty() {
            conds.push(scope);
        }
        if !tags.is_empty() {
            conds.push(format!("d.tags && {}::text[]", a.add(tags.to_vec())));
        }
        let mut where_ = conds.join(" AND ");
        let cols = "d.id, d.content, d.tags, d.client, d.created_at";
        let mut warning = String::new();
        let sql = if query.trim().is_empty() {
            if where_.is_empty() {
                where_ = "true".into();
            }
            format!("SELECT {cols}, 0::float8 FROM {} d WHERE {where_} ORDER BY d.created_at DESC LIMIT {}", t.name, a.add(k))
        } else {
            // Memories are short: always both rankings when there are embeddings.
            let mut vec = None;
            if !t.embed.is_empty() {
                match self.embed.embed(&[query.to_string()]).await {
                    Err(e) => warning = format!("embeddings unavailable, full-text results only: {e}"),
                    Ok(mut vecs) => vec = Some(vecs.swap_remove(0)),
                }
            }
            let with = ranked(t, &mut a, query, vec.as_deref(), k * CANDIDATES, &where_);
            format!("{with}\nSELECT {cols}, h.score::float8 FROM h JOIN {} d ON d.id = h.id ORDER BY h.score DESC LIMIT {}", t.name, a.add(k))
        };
        let rows = sqlx::query_with(&sql, a.args).fetch_all(&self.pool).await?;
        let items = rows.iter().map(|row| -> Result<MemoryItem> {
            let mut m = MemoryItem {
                id: row.try_get(0)?,
                content: row.try_get(1)?,
                tags: row.try_get(2)?,
                client: row.try_get(3)?,
                created_at: row.try_get(4)?,
                score: row.try_get(5)?,
            };
            if self.cfg.memory.scope == SCOPE_CLIENT {
                m.client.clear();
            }
            Ok(m)
        }).collect::<Result<_>>()?;
        Ok((items, warning))
    }

    /// Removes a memory of client's (any, with shared memory); false if there was none.
    pub async fn forget(&self, client: &str, id: i64) -> Result<bool> {
        self.writable().await?;
        let mut a = Args::default();
        let mut where_ = format!("d.id = {}", a.add(id));
        let scope = self.memory_scope(&mut a, client);
        if !scope.is_empty() {
            where_ = format!("{where_} AND {scope}");
        }
        let res = sqlx::query_with(&format!("DELETE FROM {} d WHERE {where_}", self.mems.name), a.args).execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }

    /// text's vector for t, None without embeddings or when the model fails.
    async fn try_embed(&self, t: &Table, text: &str) -> Option<Vec<f32>> {
        if t.embed.is_empty() {
            return None;
        }
        let v = self.embed.embed(&[text.to_string()]).await.ok()?.into_iter().next()?;
        let d = self.dims();
        (d == 0 || v.len() == d).then_some(v)
    }

    /// Embeds up to batch rows of the server's own tables that have no
    /// embedding yet (stored while the model was down, or before
    /// embeddings.model was set). It returns how many it embedded.
    pub async fn backfill(&self, batch: i64) -> Result<usize> {
        if self.read_only().await? {
            return Ok(0);
        }
        let mut tables = vec![];
        if self.cfg.retrieval.enabled && self.cfg.retrieval.own && !self.docs.embed.is_empty() {
            tables.push(self.docs.clone());
        }
        if self.cfg.memory.enabled && !self.mems.embed.is_empty() {
            tables.push(self.mems.clone());
        }
        let mut done = 0;
        for t in tables {
            let text = if t.title.is_empty() { "d.content" } else { r"concat_ws(E'\n', d.title, d.content)" };
            let todo: Vec<(i64, String)> = sqlx::query_as(&format!(
                "SELECT d.id, {text} FROM {} d WHERE d.{} IS NULL ORDER BY d.id LIMIT $1", t.name, quote(&t.embed_col)))
                .bind(batch).fetch_all(&self.pool).await?;
            if todo.is_empty() {
                continue;
            }
            let texts: Vec<String> = todo.iter().map(|p| p.1.clone()).collect();
            let vecs = self.embed.embed(&texts).await.map_err(|e| anyhow!(e))?;
            let mut tx = self.pool.begin().await?;
            let sql = format!("UPDATE {} SET {} = $1::vector WHERE id = $2", t.name, quote(&t.embed_col));
            for i in 0..todo.len() {
                sqlx::query(&sql).bind(vector_literal(&vecs[i])).bind(todo[i].0).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            done += todo.len();
        }
        Ok(done)
    }

    /// Deletes memories past memory.retentionDays; it returns how many.
    pub async fn expire(&self) -> Result<u64> {
        let days = self.cfg.memory.retention_days;
        if !self.cfg.memory.enabled || days <= 0 {
            return Ok(0);
        }
        if self.read_only().await? {
            return Ok(0);
        }
        let res = sqlx::query(&format!("DELETE FROM {} WHERE created_at < now() - make_interval(days => $1)", self.mems.name))
            .bind(days as i32).execute(&self.pool).await?;
        Ok(res.rows_affected())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
