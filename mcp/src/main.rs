//! basis-mcp is the MCP server of an MCPServer (ai.cndev.nl/v1alpha1):
//! retrieval and agent memory over a Project's PostgreSQL database, as MCP
//! tools over streamable HTTP, to clients with a key of their own.
//!
//!     basis-mcp --config /etc/basis-mcp/config.json --keys /etc/basis-mcp/keys
//!
//! Documents and memories live in the database: tables the server creates
//! (mcp.documents, mcp.memories), or a documents table of your own it only
//! reads. Search is hybrid by default: pgvector's cosine distance over
//! embeddings from an OpenAI-compatible endpoint (the Project's
//! ModelGateway), and PostgreSQL's full-text search, fused by reciprocal
//! rank. Memories are each client's own unless memory.scope is shared.
//!
//! The database and the embeddings endpoint come from the environment:
//! DATABASE_URL, and OPENAI_BASE_URL and OPENAI_API_KEY (the Project's
//! ModelGateway) when the config names an embeddings model.
//!
//! Every call writes one JSON line to stdout (basis: mcp; client, tool,
//! outcome, no query or content): the portal's audit trail. Logs go to
//! stderr.

mod config;
mod embed;
mod keys;
mod metrics;
mod server;
mod store;
mod tools;

use anyhow::{Context, Result, bail};
use clap::Parser;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Set at build time (VERSION in the environment of cargo build).
const VERSION: &str = match option_env!("VERSION") {
    Some(v) => v,
    None => "dev",
};

#[derive(Parser)]
#[command(version = VERSION, about = "The MCP server of an MCPServer")]
struct Args {
    /// The server's config (the composition's ConfigMap).
    #[arg(long, default_value = "/etc/basis-mcp/config.json")]
    config: String,
    /// Directory with a file per client holding its API key.
    #[arg(long, default_value = "/etc/basis-mcp/keys")]
    keys: String,
    /// Address of the MCP endpoint (/mcp) and the health checks.
    #[arg(long, default_value = ":8080")]
    listen: String,
    /// Address of /metrics.
    #[arg(long, default_value = ":9090")]
    metrics: String,
    /// Debug logs.
    #[arg(long)]
    debug: bool,
}

/// ":8080" listens on every interface.
fn address(a: &str) -> String {
    if a.starts_with(':') { format!("0.0.0.0{a}") } else { a.to_string() }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    // The server's own logs; the libraries' (a line per MCP request) only
    // when they warn, or with --debug.
    let filter = if args.debug { "info,basis_mcp=debug" } else { "warn,basis_mcp=info" };
    tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .init();
    if let Err(e) = run(args).await {
        tracing::error!(error = format!("{e:#}"), "exiting");
        std::process::exit(1);
    }
}

async fn run(args: Args) -> Result<()> {
    let cfg = config::Config::load(&args.config).map_err(anyhow::Error::msg)?;
    let db_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if db_url.is_empty() {
        bail!("DATABASE_URL is not set");
    }
    let m = Arc::new(metrics::Metrics::new());
    let mut embedder = embed::OpenAiEmbedder::new(std::env::var("OPENAI_BASE_URL").unwrap_or_default(),
        std::env::var("OPENAI_API_KEY").unwrap_or_default(), cfg.embeddings.model.clone(), cfg.embeddings.dimensions);
    if cfg.embeds() && embedder.base_url.is_empty() {
        bail!("embeddings model {} needs OPENAI_BASE_URL", cfg.embeddings.model);
    }
    let observed = m.clone();
    embedder.observe = Some(Box::new(move |outcome, d| observed.observe_embedding(outcome, d)));

    let stop = CancellationToken::new();
    let store = Arc::new(store::Store::new(&db_url, cfg.clone(), Arc::new(embedder))?);
    let keys = Arc::new(keys::Keys::new(&args.keys).context("keys")?);
    tokio::spawn({
        let (keys, stop) = (keys.clone(), stop.clone());
        async move {
            keys.watch(Duration::from_secs(15), stop, |e| tracing::warn!(error = %e, "reading keys")).await;
        }
    });
    tokio::spawn(server::maintain(store.clone(), m.clone(), stop.clone()));

    let audit = metrics::Audit::new(Box::new(std::io::stdout()), &cfg.server);
    let tools = Arc::new(tools::Tools::new(cfg.clone(), store.clone(), m.clone(), audit, VERSION));
    let ready = {
        let store = store.clone();
        move || store.problem()
    };
    let api = server::handler(tools, keys.clone(), ready, stop.clone());
    let mon = server::metrics_handler(m);
    let api_listener = tokio::net::TcpListener::bind(address(&args.listen)).await.with_context(|| format!("listening on {}", args.listen))?;
    let mon_listener = tokio::net::TcpListener::bind(address(&args.metrics)).await.with_context(|| format!("listening on {}", args.metrics))?;
    tracing::info!(server = cfg.server, namespace = cfg.namespace, site = cfg.site, tools = ?cfg.tools(),
        clients = keys.len(), version = VERSION, "serving");

    let shutdown = {
        let stop = stop.clone();
        async move {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            stop.cancel();
        }
    };
    tokio::spawn(shutdown);
    let (a, b) = tokio::join!(
        axum::serve(api_listener, api).with_graceful_shutdown(stop.clone().cancelled_owned()),
        axum::serve(mon_listener, mon).with_graceful_shutdown(stop.clone().cancelled_owned()),
    );
    store.close().await;
    a?;
    b?;
    Ok(())
}
