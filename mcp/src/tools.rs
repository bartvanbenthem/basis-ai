//! The MCP tools, and an MCP server per client holding only the tools it
//! may call.

use anyhow::{Result, anyhow, bail};
use rmcp::handler::server::common::{schema_for_output, schema_for_type};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, InitializeResult,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use crate::config::*;
use crate::embed::{BoxFuture, truncate};
use crate::metrics::{Audit, AuditRecord, Metrics};
use crate::store::{Document, MemoryItem, SNIPPET, Store};

/// What the tools need from the store (a fake in tests).
pub trait Backend: Send + Sync {
    fn problem(&self) -> String;
    fn search<'a>(&'a self, query: &'a str, k: i64, filter: &'a Map<String, Value>) -> BoxFuture<'a, Result<(Vec<Document>, String)>>;
    fn fetch<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Document>>>;
    fn add_document<'a>(&'a self, d: &'a Document) -> BoxFuture<'a, Result<(String, bool)>>;
    fn delete_document<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool>>;
    fn remember<'a>(&'a self, client: &'a str, content: &'a str, tags: &'a [String]) -> BoxFuture<'a, Result<(i64, bool)>>;
    fn recall<'a>(&'a self, client: &'a str, query: &'a str, k: i64, tags: &'a [String]) -> BoxFuture<'a, Result<(Vec<MemoryItem>, String)>>;
    fn forget<'a>(&'a self, client: &'a str, id: i64) -> BoxFuture<'a, Result<bool>>;
}

impl Backend for Store {
    fn problem(&self) -> String {
        Store::problem(self)
    }
    fn search<'a>(&'a self, query: &'a str, k: i64, filter: &'a Map<String, Value>) -> BoxFuture<'a, Result<(Vec<Document>, String)>> {
        Box::pin(Store::search(self, query, k, filter))
    }
    fn fetch<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Document>>> {
        Box::pin(Store::fetch(self, id))
    }
    fn add_document<'a>(&'a self, d: &'a Document) -> BoxFuture<'a, Result<(String, bool)>> {
        Box::pin(Store::add_document(self, d))
    }
    fn delete_document<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(Store::delete_document(self, id))
    }
    fn remember<'a>(&'a self, client: &'a str, content: &'a str, tags: &'a [String]) -> BoxFuture<'a, Result<(i64, bool)>> {
        Box::pin(Store::remember(self, client, content, tags))
    }
    fn recall<'a>(&'a self, client: &'a str, query: &'a str, k: i64, tags: &'a [String]) -> BoxFuture<'a, Result<(Vec<MemoryItem>, String)>> {
        Box::pin(Store::recall(self, client, query, k, tags))
    }
    fn forget<'a>(&'a self, client: &'a str, id: i64) -> BoxFuture<'a, Result<bool>> {
        Box::pin(Store::forget(self, client, id))
    }
}

// Limits on what a call may send.
const MAX_QUERY: usize = 4000;
const MAX_DOCUMENT: usize = 200_000;
const MAX_MEMORY: usize = 20_000;
const MAX_TAGS: usize = 20;
pub const MAX_LIMIT: i64 = 50;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SearchIn {
    /// What to look for, in natural language or keywords
    pub query: String,
    /// How many hits, 1 to 50; the server's topK by default
    #[serde(default)]
    pub limit: i64,
    /// Only documents whose metadata contains this JSON object, e.g. {"team": "support"}
    #[serde(default)]
    pub filter: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SearchOut {
    pub results: Vec<Document>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub warning: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct FetchIn {
    /// A document id from search
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddDocumentIn {
    /// The document's text
    pub content: String,
    /// A title, searched along with the content
    #[serde(default)]
    pub title: String,
    /// Where it comes from, e.g. a URL or file path
    #[serde(default)]
    pub source: String,
    /// JSON object to filter searches on
    #[serde(default)]
    pub metadata: Map<String, Value>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct AddOut {
    pub id: String,
    /// false when the embeddings model was down; it is embedded later.
    pub embedded: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteDocumentIn {
    /// The document's id
    pub id: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct DeletedOut {
    pub deleted: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RememberIn {
    /// What to remember: a fact, preference, decision or outcome, self-contained
    pub content: String,
    /// Labels to recall it by, e.g. ["preference", "customer:acme"]
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct RememberOut {
    pub id: i64,
    pub embedded: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RecallIn {
    /// What to recall; empty for the most recent memories
    #[serde(default)]
    pub query: String,
    /// How many, 1 to 50 (default 10)
    #[serde(default)]
    pub limit: i64,
    /// Only memories with any of these tags
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct RecallOut {
    pub memories: Vec<MemoryItem>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub warning: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ForgetIn {
    /// The memory's id, from recall
    pub id: i64,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ForgetOut {
    pub forgotten: bool,
}

/// Builds the MCP server of each client: the tools it may call.
pub struct Tools {
    cfg: Config,
    backend: Arc<dyn Backend>,
    metrics: Arc<Metrics>,
    audit: Audit,
    version: String,
}

/// A tool's result for the audit: hits returned or rows changed, and the
/// document or memory it concerns.
type Outcome<Out> = (Out, Option<i64>, String);

fn limit(n: i64, def: i64) -> i64 {
    if n <= 0 { def } else { n.min(MAX_LIMIT) }
}

fn check_len(field: &str, s: &str, max: usize) -> Result<()> {
    if s.len() > max {
        bail!("{field} is {} bytes; at most {max}", s.len());
    }
    Ok(())
}

fn check_tags(tags: &[String]) -> Result<()> {
    if tags.len() > MAX_TAGS {
        bail!("{} tags; at most {MAX_TAGS}", tags.len());
    }
    if tags.iter().any(|t| t.is_empty() || t.len() > 100) {
        bail!("a tag is 1 to 100 characters");
    }
    Ok(())
}

fn id_string(id: i64) -> String {
    if id == 0 { String::new() } else { id.to_string() }
}

/// What a tool's work failed with, and the audit's id for it.
struct Failed {
    err: anyhow::Error,
    id: String,
}

impl From<anyhow::Error> for Failed {
    fn from(err: anyhow::Error) -> Self {
        Failed { err, id: String::new() }
    }
}

fn failed(id: &str) -> impl FnOnce(anyhow::Error) -> Failed + '_ {
    move |err| Failed { err, id: id.to_string() }
}

impl Tools {
    pub fn new(cfg: Config, backend: Arc<dyn Backend>, metrics: Arc<Metrics>, audit: Audit, version: &str) -> Tools {
        Tools { cfg, backend, metrics, audit, version: version.into() }
    }

    /// The MCP server for client: its tools, and nothing else.
    pub fn server(self: &Arc<Self>, client: &str) -> ClientServer {
        ClientServer { tools: self.clone(), client: client.into(), allowed: self.cfg.client_tools(client) }
    }

    fn instructions(&self, allowed: &[&str]) -> String {
        let mut b = format!("MCP server {} of BASIS project {}.", self.cfg.server, self.cfg.namespace);
        if allowed.contains(&TOOL_SEARCH) {
            b.push_str(" Search the project's knowledge base before answering from general knowledge, and cite the source of what you use.");
        }
        if allowed.contains(&TOOL_RECALL) {
            b.push_str(" Recall memories at the start of a task; remember what will matter in later conversations (preferences, decisions, outcomes), never secrets.");
        }
        if allowed.is_empty() {
            b.push_str(" This client may call no tools.");
        }
        b
    }

    /// The definitions of the tools in allowed, in the order of ALL_TOOLS.
    fn definitions(&self, allowed: &[&str]) -> Vec<Tool> {
        let r = &self.cfg.retrieval;
        let scope = if self.cfg.memory.scope == SCOPE_SHARED {
            "shared by every client of this server"
        } else {
            "your own: other clients don't see them"
        };
        let read_only = ToolAnnotations::new().read_only(true).open_world(false);
        let writes = ToolAnnotations::new().destructive(false).open_world(false);
        let deletes = ToolAnnotations::new().destructive(true).idempotent(true).open_world(false);
        fn tool<In: JsonSchema + 'static, Out: JsonSchema + 'static>(name: &'static str, title: &str, description: String,
            annotations: ToolAnnotations) -> Tool {
            Tool::new(name, description, schema_for_type::<In>())
                .with_title(title)
                .with_raw_output_schema(schema_for_output::<Out>())
                .with_annotations(annotations)
        }
        let all = [
            tool::<SearchIn, SearchOut>(TOOL_SEARCH, "Search the knowledge base", format!(
                "Searches the project's documents ({} search) and returns the best hits, best first, each with an id, \
                title, source and the first {SNIPPET} characters of its content. Use fetch for a whole document.", r.mode),
                read_only.clone()),
            tool::<FetchIn, Document>(TOOL_FETCH, "Fetch a document", "Returns a whole document by the id search gave.".into(),
                read_only.clone()),
            tool::<AddDocumentIn, AddOut>(TOOL_ADD_DOCUMENT, "Add a document",
                "Adds a document to the knowledge base, searchable right away. Split long texts into sections of a few \
                paragraphs, one document each, with the same source.".into(), writes.clone()),
            tool::<DeleteDocumentIn, DeletedOut>(TOOL_DELETE_DOCUMENT, "Delete a document",
                "Removes a document from the knowledge base.".into(), deletes.clone()),
            tool::<RememberIn, RememberOut>(TOOL_REMEMBER, "Remember", format!(
                "Stores a memory for later conversations: one self-contained fact, preference, decision or outcome per call. \
                Memories are {scope}."), writes),
            tool::<RecallIn, RecallOut>(TOOL_RECALL, "Recall", format!(
                "Returns the memories most relevant to a query, best first, or the most recent ones without a query. \
                Memories are {scope}."), read_only),
            tool::<ForgetIn, ForgetOut>(TOOL_FORGET, "Forget",
                "Deletes a memory by its id (from recall), e.g. when it is wrong or outdated.".into(), deletes),
        ];
        all.into_iter().filter(|t| allowed.contains(&t.name.as_ref())).collect()
    }

    /// Runs a tool's work with what every call gets: readiness, metrics and
    /// the audit line.
    async fn call<In, Out, F, Fut>(&self, tool: &str, client: &str, args: Map<String, Value>, work: F) -> CallToolResult
    where
        In: DeserializeOwned,
        Out: Serialize,
        F: FnOnce(In) -> Fut,
        Fut: Future<Output = std::result::Result<Outcome<Out>, Failed>>,
    {
        let started = Instant::now();
        let time = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true);
        let p = self.backend.problem();
        let res = if !p.is_empty() {
            Err(Failed::from(anyhow!("the server isn't ready: {p}")))
        } else {
            match serde_json::from_value::<In>(Value::Object(args)) {
                Err(e) => Err(Failed::from(anyhow!("invalid arguments: {e}"))),
                Ok(input) => work(input).await,
            }
        };
        let mut rec = AuditRecord { time, client: client.into(), tool: tool.into(), ..Default::default() };
        let result = match res {
            Ok((out, results, id)) => {
                rec.results = results;
                rec.id = id;
                rec.outcome = "ok".into();
                CallToolResult::structured(serde_json::to_value(out).unwrap_or_default())
            }
            Err(Failed { err, id }) => {
                let msg = format!("{err:#}");
                rec.id = id;
                rec.outcome = "error".into();
                rec.error = truncate(&msg, 300);
                CallToolResult::error(vec![ContentBlock::text(msg)])
            }
        };
        let elapsed = started.elapsed();
        rec.duration_ms = elapsed.as_millis() as i64;
        self.metrics.call(tool, client, &rec.outcome).inc();
        Metrics::tool(&self.metrics.duration, tool).observe(elapsed.as_secs_f64());
        if let Some(n) = rec.results.filter(|_| tool == TOOL_SEARCH || tool == TOOL_RECALL) {
            Metrics::tool(&self.metrics.results, tool).observe(n as f64);
        }
        self.audit.write(rec);
        result
    }

    async fn dispatch(&self, client: &str, tool: &str, args: Map<String, Value>) -> CallToolResult {
        let b = &self.backend;
        let r = &self.cfg.retrieval;
        match tool {
            TOOL_SEARCH => self.call(tool, client, args, |i: SearchIn| async move {
                if i.query.trim().is_empty() {
                    return Err(anyhow!("query is empty").into());
                }
                check_len("query", &i.query, MAX_QUERY)?;
                let (results, warning) = b.search(&i.query, limit(i.limit, r.top_k), &i.filter).await?;
                let n = results.len() as i64;
                Ok((SearchOut { results, warning }, Some(n), String::new()))
            }).await,
            TOOL_FETCH => self.call(tool, client, args, |i: FetchIn| async move {
                match b.fetch(&i.id).await.map_err(failed(&i.id))? {
                    None => Err(failed(&i.id)(anyhow!("no document {:?}", i.id))),
                    Some(d) => Ok((d, Some(1), i.id)),
                }
            }).await,
            TOOL_ADD_DOCUMENT => self.call(tool, client, args, |i: AddDocumentIn| async move {
                if i.content.trim().is_empty() {
                    return Err(anyhow!("content is empty").into());
                }
                check_len("content", &i.content, MAX_DOCUMENT)?;
                let d = Document { content: i.content, title: i.title, source: i.source, metadata: i.metadata, ..Default::default() };
                let (id, embedded) = b.add_document(&d).await?;
                Ok((AddOut { id: id.clone(), embedded }, Some(1), id))
            }).await,
            TOOL_DELETE_DOCUMENT => self.call(tool, client, args, |i: DeleteDocumentIn| async move {
                let deleted = b.delete_document(&i.id).await.map_err(failed(&i.id))?;
                Ok((DeletedOut { deleted }, Some(deleted as i64), i.id))
            }).await,
            TOOL_REMEMBER => self.call(tool, client, args, |i: RememberIn| async move {
                if i.content.trim().is_empty() {
                    return Err(anyhow!("content is empty").into());
                }
                check_len("content", &i.content, MAX_MEMORY)?;
                check_tags(&i.tags)?;
                let (id, embedded) = b.remember(client, &i.content, &i.tags).await?;
                Ok((RememberOut { id, embedded }, Some(1), id_string(id)))
            }).await,
            TOOL_RECALL => self.call(tool, client, args, |i: RecallIn| async move {
                check_len("query", &i.query, MAX_QUERY)?;
                check_tags(&i.tags)?;
                let (memories, warning) = b.recall(client, &i.query, limit(i.limit, 10), &i.tags).await?;
                let n = memories.len() as i64;
                Ok((RecallOut { memories, warning }, Some(n), String::new()))
            }).await,
            TOOL_FORGET => self.call(tool, client, args, |i: ForgetIn| async move {
                let forgotten = b.forget(client, i.id).await.map_err(failed(&id_string(i.id)))?;
                Ok((ForgetOut { forgotten }, Some(forgotten as i64), id_string(i.id)))
            }).await,
            _ => unreachable!("dispatch of an unknown tool {tool}"),
        }
    }
}

/// One client's MCP server.
#[derive(Clone)]
pub struct ClientServer {
    tools: Arc<Tools>,
    client: String,
    allowed: Vec<&'static str>,
}

impl ServerHandler for ClientServer {
    fn get_info(&self) -> InitializeResult {
        let t = &self.tools;
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("basis-mcp", &t.version).with_title(format!("BASIS: {}", t.cfg.server)))
            .with_instructions(t.instructions(&self.allowed))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, McpError> {
        Ok(ListToolsResult { tools: self.tools.definitions(&self.allowed), ..Default::default() })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, McpError> {
        // A tool it may not call doesn't exist for it.
        let Some(tool) = self.allowed.iter().find(|t| **t == request.name) else {
            return Err(McpError::invalid_params(format!("unknown tool {:?}", request.name), None));
        };
        let args = request.arguments.unwrap_or_default();
        Ok(self.tools.dispatch(&self.client, tool, args).await.into())
    }
}
