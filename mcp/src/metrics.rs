//! The server's metrics, scraped by the Project's Prometheus (the
//! MCPServer's PodMonitor), and its audit lines.

use prometheus_client::encoding::text::encode;
use prometheus_client::metrics::counter::Counter;
use prometheus_client::metrics::family::Family;
use prometheus_client::metrics::gauge::Gauge;
use prometheus_client::metrics::histogram::Histogram;
use prometheus_client::registry::Registry;
use serde::Serialize;
use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

type Labels = Vec<(&'static str, String)>;

/// Calls per tool, client and outcome, their duration, the embedding calls
/// and whether the database is ready.
pub struct Metrics {
    registry: Registry,
    pub calls: Family<Labels, Counter>,
    pub duration: Family<Labels, Histogram>,
    pub results: Family<Labels, Histogram>,
    pub embeddings: Family<Labels, Counter>,
    pub embed_time: Histogram,
    pub ready: Gauge,
    pub backfilled: Counter,
    pub expired: Counter,
}

fn duration_histogram() -> Histogram {
    Histogram::new([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0])
}

fn results_histogram() -> Histogram {
    Histogram::new([0.0, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 50.0])
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    pub fn new() -> Metrics {
        let mut m = Metrics {
            registry: Registry::default(),
            calls: Family::default(),
            duration: Family::new_with_constructor(duration_histogram),
            results: Family::new_with_constructor(results_histogram),
            embeddings: Family::default(),
            embed_time: Histogram::new([0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]),
            ready: Gauge::default(),
            backfilled: Counter::default(),
            expired: Counter::default(),
        };
        let r = &mut m.registry;
        // Counters get their _total suffix from the encoder.
        r.register("basis_mcp_tool_calls", "Tool calls by tool, client and outcome (ok, error).", m.calls.clone());
        r.register("basis_mcp_tool_duration_seconds", "How long tool calls take.", m.duration.clone());
        r.register("basis_mcp_tool_results", "Hits a search or recall returns.", m.results.clone());
        r.register("basis_mcp_embedding_requests", "Calls to the embeddings model by outcome.", m.embeddings.clone());
        r.register("basis_mcp_embedding_duration_seconds", "How long the embeddings model takes.", m.embed_time.clone());
        r.register("basis_mcp_database_ready", "1 when the database and its tables are ready.", m.ready.clone());
        r.register("basis_mcp_backfilled_embeddings", "Rows embedded after they were stored.", m.backfilled.clone());
        r.register("basis_mcp_expired_memories", "Memories deleted past memory.retentionDays.", m.expired.clone());
        m
    }

    /// The embedder's observe.
    pub fn observe_embedding(&self, outcome: &str, d: Duration) {
        self.embeddings.get_or_create(&vec![("outcome", outcome.to_string())]).inc();
        self.embed_time.observe(d.as_secs_f64());
    }

    pub fn call(&self, tool: &str, client: &str, outcome: &str) -> Counter {
        self.calls
            .get_or_create(&vec![("tool", tool.to_string()), ("client", client.to_string()), ("outcome", outcome.to_string())])
            .clone()
    }

    pub fn tool(family: &Family<Labels, Histogram>, tool: &str) -> Histogram {
        family.get_or_create(&vec![("tool", tool.to_string())]).clone()
    }

    /// The text exposition of every metric.
    pub fn encode(&self) -> String {
        let mut out = String::new();
        encode(&mut out, &self.registry).expect("encoding metrics");
        out
    }
}

/// One JSON line per tool call: who called which tool and how it went,
/// never the query or the content. The portal's audit trail reads these
/// lines (field basis: mcp) from the pods' logs.
pub struct Audit {
    w: Mutex<Box<dyn Write + Send>>,
    server: String,
}

/// One line.
#[derive(Debug, Default, Serialize, serde::Deserialize)]
pub struct AuditRecord {
    pub basis: String,
    pub time: String,
    pub server: String,
    pub client: String,
    pub tool: String,
    pub outcome: String,
    pub duration_ms: i64,
    /// Hits returned, or rows changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<i64>,
    /// The document or memory a call wrote, read or removed.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
}

impl Audit {
    pub fn new(w: Box<dyn Write + Send>, server: &str) -> Audit {
        Audit { w: Mutex::new(w), server: server.into() }
    }

    pub fn write(&self, mut r: AuditRecord) {
        r.basis = "mcp".into();
        r.server = self.server.clone();
        let mut raw = serde_json::to_vec(&r).unwrap_or_default();
        raw.push(b'\n');
        let mut w = self.w.lock().unwrap();
        let _ = w.write_all(&raw);
        let _ = w.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposition() {
        let m = Metrics::new();
        m.observe_embedding("ok", Duration::ZERO);
        let text = m.encode();
        for want in [r#"basis_mcp_embedding_requests_total{outcome="ok"} 1"#, "basis_mcp_database_ready 0"] {
            assert!(text.contains(want), "/metrics lacks {want:?}:\n{text}");
        }
    }
}
