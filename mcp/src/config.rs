//! The server's config: what the composition writes into its ConfigMap
//! (config.json). Its JSON mirrors the MCPServer's spec, with the defaults
//! already applied.

use regex::Regex;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::LazyLock;

// Tool names.
pub const TOOL_SEARCH: &str = "search";
pub const TOOL_FETCH: &str = "fetch";
pub const TOOL_ADD_DOCUMENT: &str = "add_document";
pub const TOOL_DELETE_DOCUMENT: &str = "delete_document";
pub const TOOL_REMEMBER: &str = "remember";
pub const TOOL_RECALL: &str = "recall";
pub const TOOL_FORGET: &str = "forget";

/// Every tool, in the order tools/list shows them.
pub const ALL_TOOLS: &[&str] =
    &[TOOL_SEARCH, TOOL_FETCH, TOOL_ADD_DOCUMENT, TOOL_DELETE_DOCUMENT, TOOL_REMEMBER, TOOL_RECALL, TOOL_FORGET];

// Search modes.
pub const MODE_HYBRID: &str = "hybrid";
pub const MODE_VECTOR: &str = "vector";
pub const MODE_TEXT: &str = "text";

// Memory scopes.
pub const SCOPE_CLIENT: &str = "client";
pub const SCOPE_SHARED: &str = "shared";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Server and namespace name the MCPServer, for logs and metrics.
    pub server: String,
    pub namespace: String,
    /// The site this copy runs in (protected, recovery).
    pub site: String,
    pub retrieval: Retrieval,
    pub memory: Memory,
    pub embeddings: Embeddings,
    /// Clients by name; their keys are files in the keys directory.
    pub clients: BTreeMap<String, Client>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Retrieval {
    pub enabled: bool,
    /// schema.table. own: the server creates it (mcp.documents); otherwise
    /// it's yours and only read, through columns.
    pub table: String,
    pub own: bool,
    pub columns: Columns,
    pub mode: String,
    pub top_k: i64,
    /// The PostgreSQL text search configuration (simple, english, dutch, ...).
    pub text_search_config: String,
    /// Adds add_document and delete_document (own table only).
    pub ingest: bool,
}

/// Columns of a documents table of your own. content and id are required;
/// the others may be empty.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Columns {
    pub id: String,
    pub content: String,
    pub title: String,
    pub source: String,
    pub metadata: String,
    pub embedding: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Memory {
    pub enabled: bool,
    pub table: String,
    pub scope: String,
    /// Deletes memories older than this; 0 keeps them.
    pub retention_days: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Embeddings {
    /// Model at the OpenAI-compatible endpoint (OPENAI_BASE_URL); empty:
    /// full-text search only.
    pub model: String,
    /// Asks the model for this many (models that support it); 0 takes the
    /// model's own.
    pub dimensions: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Client {
    /// Tools the client may call; empty, every tool the server serves.
    pub tools: Vec<String>,
}

static QUALIFIED_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$").unwrap());
static COLUMN_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z_][a-z0-9_]{0,62}$").unwrap());
static TS_CONFIG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z_][a-z0-9_]{0,62}$").unwrap());

impl Config {
    /// Reads and checks a config file.
    pub fn load(path: &str) -> Result<Config, String> {
        let raw = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        let mut c: Config = serde_json::from_slice(&raw).map_err(|e| format!("{path}: {e}"))?;
        c.defaults();
        c.validate().map_err(|e| format!("{path}: {e}"))?;
        Ok(c)
    }

    pub fn defaults(&mut self) {
        let r = &mut self.retrieval;
        if r.table.is_empty() {
            r.table = "mcp.documents".into();
            r.own = true;
        }
        if r.own {
            r.columns = Columns {
                id: "id".into(),
                content: "content".into(),
                title: "title".into(),
                source: "source".into(),
                metadata: "metadata".into(),
                embedding: "embedding".into(),
            };
        }
        if r.columns.id.is_empty() {
            r.columns.id = "id".into();
        }
        if r.columns.content.is_empty() {
            r.columns.content = "content".into();
        }
        if r.mode.is_empty() {
            r.mode = MODE_HYBRID.into();
        }
        if r.top_k == 0 {
            r.top_k = 8;
        }
        if r.text_search_config.is_empty() {
            r.text_search_config = "simple".into();
        }
        if self.memory.table.is_empty() {
            self.memory.table = "mcp.memories".into();
        }
        if self.memory.scope.is_empty() {
            self.memory.scope = SCOPE_CLIENT.into();
        }
    }

    /// Checks what the SQL is built from: names are never quoted from
    /// untrusted input without passing these patterns.
    pub fn validate(&self) -> Result<(), String> {
        let r = &self.retrieval;
        if !QUALIFIED_NAME.is_match(&r.table) {
            return Err(format!("retrieval.table {:?}: want schema.table, lowercase", r.table));
        }
        if !QUALIFIED_NAME.is_match(&self.memory.table) {
            return Err(format!("memory.table {:?}: want schema.table, lowercase", self.memory.table));
        }
        let c = &r.columns;
        for (field, col) in [("id", &c.id), ("content", &c.content), ("title", &c.title), ("source", &c.source),
            ("metadata", &c.metadata), ("embedding", &c.embedding)]
        {
            if !col.is_empty() && !COLUMN_NAME.is_match(col) {
                return Err(format!("retrieval.columns.{field} {col:?}: not a column name"));
            }
        }
        if !TS_CONFIG.is_match(&r.text_search_config) {
            return Err(format!("retrieval.textSearchConfig {:?}: not a text search configuration", r.text_search_config));
        }
        if ![MODE_HYBRID, MODE_VECTOR, MODE_TEXT].contains(&r.mode.as_str()) {
            return Err(format!("retrieval.mode {:?}: hybrid, vector or text", r.mode));
        }
        if r.mode != MODE_TEXT && self.embeddings.model.is_empty() {
            // Without a model there is nothing to compare vectors with.
            return Err(format!("retrieval.mode {} needs embeddings.model", r.mode));
        }
        if !(1..=50).contains(&r.top_k) {
            return Err(format!("retrieval.topK {}: 1 to 50", r.top_k));
        }
        if r.ingest && !r.own {
            return Err(format!("retrieval.ingest is for the server's own table, not {}", r.table));
        }
        if ![SCOPE_CLIENT, SCOPE_SHARED].contains(&self.memory.scope.as_str()) {
            return Err(format!("memory.scope {:?}: client or shared", self.memory.scope));
        }
        for (name, cl) in &self.clients {
            if let Some(t) = cl.tools.iter().find(|t| !ALL_TOOLS.contains(&t.as_str())) {
                return Err(format!("clients.{name}.tools: unknown tool {t:?}"));
            }
        }
        Ok(())
    }

    /// The tools this server serves, whatever a client may call.
    pub fn tools(&self) -> Vec<&'static str> {
        let mut out = vec![];
        if self.retrieval.enabled {
            out.extend([TOOL_SEARCH, TOOL_FETCH]);
            if self.retrieval.ingest {
                out.extend([TOOL_ADD_DOCUMENT, TOOL_DELETE_DOCUMENT]);
            }
        }
        if self.memory.enabled {
            out.extend([TOOL_REMEMBER, TOOL_RECALL, TOOL_FORGET]);
        }
        out
    }

    /// The tools client may call: the server's, narrowed to its list if it
    /// has one. A client the config doesn't list gets none.
    pub fn client_tools(&self, client: &str) -> Vec<&'static str> {
        let Some(cl) = self.clients.get(client) else { return vec![] };
        let served = self.tools();
        if cl.tools.is_empty() {
            return served;
        }
        served.into_iter().filter(|t| cl.tools.iter().any(|c| c == t)).collect()
    }

    /// The server computes embeddings.
    pub fn embeds(&self) -> bool {
        !self.embeddings.model.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"server":"kb","retrieval":{"enabled":true},"memory":{"enabled":true},
            "embeddings":{"model":"text-embedding-3-small"},"clients":{"agents":{}}}"#).unwrap();
        let c = Config::load(path.to_str().unwrap()).unwrap();
        let r = &c.retrieval;
        assert!(r.table == "mcp.documents" && r.own && r.mode == MODE_HYBRID && r.top_k == 8 && r.text_search_config == "simple"
            && r.columns.embedding == "embedding" && c.memory.table == "mcp.memories" && c.memory.scope == SCOPE_CLIENT,
            "defaults: {c:?}");
        assert_eq!(c.client_tools("agents"), [TOOL_SEARCH, TOOL_FETCH, TOOL_REMEMBER, TOOL_RECALL, TOOL_FORGET]);
    }

    #[test]
    fn validate() {
        type Edit = fn(&mut Config);
        let cases: Vec<(&str, Edit, &str)> = vec![
            ("injection in a table", |c| c.retrieval.table = r#"public.docs"; DROP TABLE x; --"#.into(), "want schema.table"),
            ("injection in a column", |c| c.retrieval.columns.content = "body) --".into(), "not a column name"),
            ("injection in a ts config", |c| c.retrieval.text_search_config = "english'::regconfig".into(), "not a text search configuration"),
            ("vector without a model", |c| c.embeddings.model = String::new(), "needs embeddings.model"),
            ("ingest into your table", |c| {
                c.retrieval.table = "app.docs".into();
                c.retrieval.own = false;
                c.retrieval.ingest = true;
            }, "server's own table"),
            ("unknown tool", |c| {
                c.clients.insert("x".into(), Client { tools: vec!["drop_table".into()] });
            }, r#"unknown tool "drop_table""#),
            ("topK", |c| c.retrieval.top_k = 51, "1 to 50"),
        ];
        for (name, edit, want) in cases {
            let mut c = Config {
                retrieval: Retrieval { enabled: true, ..Default::default() },
                memory: Memory { enabled: true, ..Default::default() },
                embeddings: Embeddings { model: "m".into(), ..Default::default() },
                ..Default::default()
            };
            c.defaults();
            edit(&mut c);
            match c.validate() {
                Err(e) => assert!(e.contains(want), "{name}: got {e}, want {want:?}"),
                Ok(()) => panic!("{name}: valid, want {want:?}"),
            }
        }
    }

    #[test]
    fn client_tools() {
        let c = Config {
            retrieval: Retrieval { enabled: true, ..Default::default() },
            clients: BTreeMap::from([
                ("a".into(), Client::default()),
                ("b".into(), Client { tools: vec![TOOL_FETCH.into(), TOOL_RECALL.into()] }),
            ]),
            ..Default::default()
        };
        assert_eq!(c.client_tools("a"), [TOOL_SEARCH, TOOL_FETCH]);
        // Only what the server serves: memory is off.
        assert_eq!(c.client_tools("b"), [TOOL_FETCH]);
        assert!(c.client_tools("nobody").is_empty(), "an unlisted client");
    }
}
