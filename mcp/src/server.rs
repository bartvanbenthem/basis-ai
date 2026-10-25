//! The HTTP side: /mcp for clients with a key, the health checks, /metrics,
//! and the loop that keeps the store ready.

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::keys::Keys;
use crate::metrics::Metrics;
use crate::store::Store;
use crate::tools::{ClientServer, Tools};

/// The path the MCP endpoint is served at.
pub const PATH: &str = "/mcp";

type Service = StreamableHttpService<ClientServer, NeverSessionManager>;

struct Api {
    tools: Arc<Tools>,
    keys: Arc<Keys>,
    ready: Box<dyn Fn() -> String + Send + Sync>,
    /// client -> its MCP service.
    servers: Mutex<HashMap<String, Service>>,
    stop: CancellationToken,
}

impl Api {
    fn service(&self, client: &str) -> Service {
        let mut servers = self.servers.lock().unwrap();
        servers.entry(client.to_string()).or_insert_with(|| {
            let server = self.tools.server(client);
            // Stateless: any replica answers any request, no session
            // affinity needed. Clients reach it by the Service's name, so
            // no Host allowlist.
            let config = StreamableHttpServerConfig::default()
                .with_legacy_session_mode(false)
                .with_json_response(true)
                .disable_allowed_hosts()
                .with_cancellation_token(self.stop.child_token());
            StreamableHttpService::new(move || Ok(server.clone()), Arc::new(NeverSessionManager::default()), config)
        }).clone()
    }
}

/// Serves /mcp to clients with a key (Authorization: Bearer <key>), each
/// with an MCP server of its own tools, plus /healthz and /readyz.
pub fn handler(tools: Arc<Tools>, keys: Arc<Keys>, ready: impl Fn() -> String + Send + Sync + 'static, stop: CancellationToken) -> Router {
    let api = Arc::new(Api { tools, keys, ready: Box::new(ready), servers: Mutex::default(), stop });
    Router::new()
        .route(PATH, any(mcp))
        .route("/healthz", get(|| async { StatusCode::OK }))
        .route("/readyz", get(readyz))
        .with_state(api)
}

async fn mcp(State(api): State<Arc<Api>>, req: Request) -> Response {
    // Keys don't expire by themselves: the composition revokes them.
    let token = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::trim);
    let Some(client) = token.filter(|t| !t.is_empty()).and_then(|t| api.keys.client(t)) else {
        return (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Bearer")], "invalid token\n").into_response();
    };
    api.service(&client).handle(req).await.map(Body::new)
}

async fn readyz(State(api): State<Arc<Api>>) -> Response {
    let p = (api.ready)();
    if !p.is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE, format!("{p}\n")).into_response();
    }
    "ok".into_response()
}

/// Serves /metrics.
pub fn metrics_handler(m: Arc<Metrics>) -> Router {
    Router::new().route("/metrics", get(move || {
        let m = m.clone();
        async move { ([(header::CONTENT_TYPE, "application/openmetrics-text; version=1.0.0; charset=utf-8")], m.encode()) }
    }))
}

/// Prepares the store, logging when its problem changes.
async fn try_prepare(store: &Store, m: &Metrics, last: &mut String) {
    let problem = match store.prepare().await {
        Ok(()) => String::new(),
        Err(e) => format!("{e:#}"),
    };
    if problem != *last {
        if problem.is_empty() {
            tracing::info!(dims = store.dims(), "ready");
        } else {
            tracing::warn!(problem, "not ready");
        }
        *last = problem.clone();
    }
    m.ready.set(problem.is_empty() as i64);
}

/// Keeps the store ready until stop: prepares it until that works (and
/// again when the database stops answering), embeds what was stored without
/// an embedding, and expires old memories.
pub async fn maintain(store: Arc<Store>, m: Arc<Metrics>, stop: CancellationToken) {
    let every = |secs| {
        let mut t = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(secs), Duration::from_secs(secs));
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        t
    };
    let (mut prepare, mut backfill, mut expire) = (every(10), every(30), every(3600));
    let mut last = "not prepared yet".to_string();
    try_prepare(&store, &m, &mut last).await;
    loop {
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = prepare.tick() => {
                if !store.problem().is_empty() || store.ping().await.is_err() {
                    try_prepare(&store, &m, &mut last).await;
                }
            }
            _ = backfill.tick() => {
                if !store.problem().is_empty() {
                    continue;
                }
                match store.backfill(64).await {
                    Err(e) => tracing::warn!(error = format!("{e:#}"), "backfilling embeddings"),
                    Ok(0) => {}
                    Ok(n) => {
                        m.backfilled.inc_by(n as u64);
                        tracing::info!(rows = n, "backfilled embeddings");
                    }
                }
            }
            _ = expire.tick() => {
                if !store.problem().is_empty() {
                    continue;
                }
                match store.expire().await {
                    Err(e) => tracing::warn!(error = format!("{e:#}"), "expiring memories"),
                    Ok(0) => {}
                    Ok(n) => {
                        m.expired.inc_by(n);
                        tracing::info!(rows = n, "expired memories");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
