use super::*;
use crate::config::*;
use crate::embed::BoxFuture;
use crate::metrics::{Audit, AuditRecord};
use crate::store::{Document, MemoryItem};
use crate::tools::{Backend, MAX_LIMIT};
use anyhow::Result;
use rmcp::model::{CallToolRequestParams, CallToolResult, ClientConfig};
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::Write;

/// Records what the tools ask of the store.
#[derive(Default)]
struct FakeBackend {
    problem: Mutex<String>,
    recalled: Mutex<Vec<String>>,
    remember: Mutex<Vec<String>>,
}

impl Backend for FakeBackend {
    fn problem(&self) -> String {
        self.problem.lock().unwrap().clone()
    }
    fn search<'a>(&'a self, q: &'a str, k: i64, _: &'a Map<String, Value>) -> BoxFuture<'a, Result<(Vec<Document>, String)>> {
        Box::pin(async move {
            Ok((vec![Document { id: "1".into(), title: "Refunds".into(), content: format!("within {q}"), score: k as f64,
                ..Default::default() }], String::new()))
        })
    }
    fn fetch<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Document>>> {
        Box::pin(async move {
            Ok((id == "1").then(|| Document { id: "1".into(), content: "all of it".into(), ..Default::default() }))
        })
    }
    fn add_document<'a>(&'a self, _: &'a Document) -> BoxFuture<'a, Result<(String, bool)>> {
        Box::pin(async { Ok(("7".into(), true)) })
    }
    fn delete_document<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async { Ok(true) })
    }
    fn remember<'a>(&'a self, client: &'a str, content: &'a str, _: &'a [String]) -> BoxFuture<'a, Result<(i64, bool)>> {
        Box::pin(async move {
            self.remember.lock().unwrap().push(format!("{client}: {content}"));
            Ok((3, true))
        })
    }
    fn recall<'a>(&'a self, client: &'a str, _: &'a str, _: i64, _: &'a [String]) -> BoxFuture<'a, Result<(Vec<MemoryItem>, String)>> {
        Box::pin(async move {
            self.recalled.lock().unwrap().push(client.into());
            Ok((vec![MemoryItem { id: 3, content: "remembered".into(), ..Default::default() }], String::new()))
        })
    }
    fn forget<'a>(&'a self, _: &'a str, _: i64) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async { Ok(true) })
    }
}

/// A Write the test reads back.
#[derive(Clone, Default)]
struct Buffer(Arc<Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Buffer {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

struct TestServer {
    url: String,
    backend: Arc<FakeBackend>,
    audit: Buffer,
    metrics: Arc<Metrics>,
    keys_dir: tempfile::TempDir,
    keys: Arc<Keys>,
}

type Session = RunningService<RoleClient, ClientConfig>;

async fn start_server(mut cfg: Config) -> TestServer {
    cfg.defaults();
    cfg.validate().unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (client, key) in [("agent", "key-agent"), ("reader", "key-reader")] {
        std::fs::write(dir.path().join(client), format!("{key}\n")).unwrap();
    }
    // A Secret volume's bookkeeping entries.
    std::fs::create_dir(dir.path().join("..data")).unwrap();
    let keys = Arc::new(Keys::new(dir.path()).unwrap());
    let backend = Arc::new(FakeBackend::default());
    let audit = Buffer::default();
    let metrics = Arc::new(Metrics::new());
    let tools = Arc::new(Tools::new(cfg.clone(), backend.clone(), metrics.clone(), Audit::new(Box::new(audit.clone()), &cfg.server), "test"));
    let b = backend.clone();
    let app = handler(tools, keys.clone(), move || b.problem(), CancellationToken::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    TestServer { url, backend, audit, metrics, keys_dir: dir, keys }
}

impl TestServer {
    async fn connect(&self, key: &str) -> Result<Session> {
        let mut config = StreamableHttpClientTransportConfig::with_uri(format!("{}{PATH}", self.url));
        if !key.is_empty() {
            config = config.auth_header(key);
        }
        Ok(ClientConfig::default().serve(StreamableHttpClientTransport::from_config(config)).await?)
    }
}

async fn tool_names(s: &Session) -> Vec<String> {
    let mut names: Vec<String> = s.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
    names.sort();
    names
}

fn full_config() -> Config {
    Config {
        server: "kb".into(),
        namespace: "demo".into(),
        retrieval: Retrieval { enabled: true, ingest: true, ..Default::default() },
        memory: Memory { enabled: true, ..Default::default() },
        embeddings: Embeddings { model: "m".into(), ..Default::default() },
        clients: BTreeMap::from([
            ("agent".into(), Client::default()),
            ("reader".into(), Client { tools: vec![TOOL_SEARCH.into(), TOOL_FETCH.into(), TOOL_REMEMBER.into()] }),
        ]),
        ..Default::default()
    }
}

async fn call(s: &Session, tool: &str, args: Value) -> Result<CallToolResult> {
    let Value::Object(args) = args else { panic!("arguments are an object") };
    Ok(s.call_tool(CallToolRequestParams::new(tool.to_string()).with_arguments(args)).await?)
}

fn text(res: &CallToolResult) -> String {
    serde_json::to_string(&res.content).unwrap()
}

#[tokio::test]
async fn tools_per_client() {
    let ts = start_server(full_config()).await;
    let agent = ts.connect("key-agent").await.unwrap();
    let mut all: Vec<String> = ALL_TOOLS.iter().map(|t| t.to_string()).collect();
    all.sort();
    assert_eq!(tool_names(&agent).await, all);
    let reader = ts.connect("key-reader").await.unwrap();
    assert_eq!(tool_names(&reader).await, [TOOL_FETCH, TOOL_REMEMBER, TOOL_SEARCH]);
    // A tool it may not call doesn't exist for it.
    match call(&reader, TOOL_FORGET, json!({"id": 3})).await {
        Ok(res) if res.is_error != Some(true) => panic!("reader called forget: {res:?}"),
        _ => {}
    }
    let instructions = agent.peer_info().and_then(|i| i.instructions.clone()).unwrap_or_default();
    assert!(instructions.contains("Recall memories"), "instructions: {instructions:?}");
    agent.cancel().await.unwrap();
    reader.cancel().await.unwrap();
}

#[tokio::test]
async fn tool_calls() {
    let ts = start_server(full_config()).await;
    let s = ts.connect("key-agent").await.unwrap();

    let res = call(&s, TOOL_SEARCH, json!({"query": "refund", "limit": 500})).await.unwrap();
    assert_ne!(res.is_error, Some(true), "search: {res:?}");
    let out: crate::tools::SearchOut = serde_json::from_value(res.structured_content.clone().unwrap()).unwrap();
    assert!(out.results.len() == 1 && out.results[0].score == MAX_LIMIT as f64, "search output {out:?} (limit clamped to {MAX_LIMIT})");

    // Memory is the calling client's: the tool passes who called.
    let res = call(&s, TOOL_REMEMBER, json!({"content": "prefers euros", "tags": ["pref"]})).await.unwrap();
    assert_ne!(res.is_error, Some(true), "remember: {res:?}");
    let res = call(&s, TOOL_RECALL, json!({"query": "currency"})).await.unwrap();
    assert_ne!(res.is_error, Some(true), "recall: {res:?}");
    assert_eq!(*ts.backend.remember.lock().unwrap(), ["agent: prefers euros"]);
    assert_eq!(*ts.backend.recalled.lock().unwrap(), ["agent"]);

    // Tool errors are results the model sees, not protocol errors.
    let res = call(&s, TOOL_FETCH, json!({"id": "9"})).await.unwrap();
    assert_eq!(res.is_error, Some(true), "fetch of a missing document: {res:?}");
    let res = call(&s, TOOL_SEARCH, json!({"query": "  "})).await.unwrap();
    assert_eq!(res.is_error, Some(true), "empty query: {res:?}");

    // One audit line per call, without the query or the content.
    let audit = ts.audit.text();
    let lines: Vec<&str> = audit.trim().lines().collect();
    assert_eq!(lines.len(), 5, "audit lines:\n{audit}");
    let first: AuditRecord = serde_json::from_str(lines[0]).unwrap();
    assert!(first.basis == "mcp" && first.server == "kb" && first.client == "agent" && first.tool == TOOL_SEARCH
        && first.outcome == "ok" && first.results == Some(1) && !first.time.is_empty(), "audit line {first:?}");
    assert!(!audit.contains("refund") && !audit.contains("euros"), "the audit log carries a query or content:\n{audit}");
    assert!(lines[3].contains(r#""outcome":"error""#) && lines[3].contains(r#""id":"9""#), "failed fetch's audit line: {}", lines[3]);
    assert_eq!(ts.metrics.call(TOOL_SEARCH, "agent", "error").get(), 1, "search errors counted");
    assert_eq!(ts.metrics.call(TOOL_REMEMBER, "agent", "ok").get(), 1, "remember calls counted");
    s.cancel().await.unwrap();
}

#[tokio::test]
async fn not_ready() {
    let ts = start_server(full_config()).await;
    *ts.backend.problem.lock().unwrap() = "can't reach the database".into();
    let s = ts.connect("key-agent").await.unwrap();
    let res = call(&s, TOOL_RECALL, json!({})).await.unwrap();
    assert!(res.is_error == Some(true) && text(&res).contains("isn't ready: can't reach the database"), "call while not ready: {res:?}");
    let resp = reqwest::get(format!("{}/readyz", ts.url)).await.unwrap();
    assert_eq!(resp.status(), 503);
    s.cancel().await.unwrap();
}

#[tokio::test]
async fn auth() {
    let ts = start_server(full_config()).await;
    for key in ["", "wrong", "key-agen"] {
        if let Ok(s) = ts.connect(key).await {
            let _ = s.cancel().await;
            panic!("connected with key {key:?}");
        }
    }
    let http = reqwest::Client::new();
    let resp = http.post(format!("{}{PATH}", ts.url)).body("{}").send().await.unwrap();
    assert_eq!(resp.status(), 401, "no key");
    let resp = http.get(format!("{}/healthz", ts.url)).send().await.unwrap();
    assert_eq!(resp.status(), 200, "healthz needs no key");

    // A revoked key stops working once the keys are read again.
    std::fs::remove_file(ts.keys_dir.path().join("reader")).unwrap();
    ts.keys.reload().unwrap();
    if let Ok(s) = ts.connect("key-reader").await {
        let _ = s.cancel().await;
        panic!("connected with a revoked key");
    }
    assert_eq!(ts.keys.len(), 1, "keys after revoking one");
}

#[tokio::test]
async fn unlisted_client_has_no_tools() {
    let mut cfg = full_config();
    cfg.clients.remove("reader");
    let ts = start_server(cfg).await;
    let s = ts.connect("key-reader").await.unwrap();
    assert!(tool_names(&s).await.is_empty(), "a client the config doesn't list has tools");
    s.cancel().await.unwrap();
}

#[tokio::test]
async fn metrics_endpoint() {
    let m = Arc::new(Metrics::new());
    m.observe_embedding("ok", Duration::ZERO);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/metrics", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, metrics_handler(m)).await.unwrap() });
    let body = reqwest::get(url).await.unwrap().text().await.unwrap();
    for want in [r#"basis_mcp_embedding_requests_total{outcome="ok"} 1"#, "basis_mcp_database_ready 0"] {
        assert!(body.contains(want), "/metrics lacks {want:?}");
    }
}
