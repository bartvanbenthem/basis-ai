//! Embeddings: texts into vectors, from an OpenAI-compatible endpoint.

use serde::Deserialize;
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Told the outcome (ok, error) and duration of each call to the model.
pub type Observe = Box<dyn Fn(&str, Duration) + Send + Sync>;

/// Turns texts into vectors.
pub trait Embedder: Send + Sync {
    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, String>>;
}

/// Calls an OpenAI-compatible /embeddings endpoint: the Project's
/// ModelGateway, with the server's own client key there.
pub struct OpenAiEmbedder {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// When set, sent along (models that can shorten).
    pub dimensions: i64,
    pub http: reqwest::Client,
    /// When set, told how each call went.
    pub observe: Option<Observe>,
}

/// What the server sends in one request at most.
const MAX_BATCH: usize = 64;

impl OpenAiEmbedder {
    pub fn new(base_url: String, api_key: String, model: String, dimensions: i64) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().expect("HTTP client");
        OpenAiEmbedder { base_url, api_key, model, dimensions, http, observe: None }
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let started = Instant::now();
        let out = self.request(texts).await;
        if let Some(observe) = &self.observe {
            observe(if out.is_ok() { "ok" } else { "error" }, started.elapsed());
        }
        out
    }

    async fn request(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let mut body = json!({"model": self.model, "input": texts, "encoding_format": "float"});
        if self.dimensions > 0 {
            body["dimensions"] = json!(self.dimensions);
        }
        let mut req = self.http.post(format!("{}/embeddings", self.base_url.trim_end_matches('/'))).json(&body);
        if !self.api_key.is_empty() {
            req = req.bearer_auth(&self.api_key);
        }
        let resp = req.send().await.map_err(|e| format!("embeddings: {e}"))?;
        let status = resp.status();
        let payload = resp.bytes().await.map_err(|e| format!("embeddings: {e}"))?;
        if status != reqwest::StatusCode::OK {
            return Err(format!("embeddings: model {} answered {}: {}", self.model, status.as_u16(),
                truncate(&String::from_utf8_lossy(&payload), 300)));
        }
        #[derive(Deserialize)]
        struct Item {
            #[serde(default)]
            index: i64,
            #[serde(default)]
            embedding: Vec<f32>,
        }
        #[derive(Deserialize)]
        struct Response {
            #[serde(default)]
            data: Vec<Item>,
        }
        let parsed: Response = serde_json::from_slice(&payload).map_err(|e| format!("embeddings: {e}"))?;
        if parsed.data.len() != texts.len() {
            return Err(format!("embeddings: {} vectors for {} texts", parsed.data.len(), texts.len()));
        }
        let mut vecs = vec![vec![]; texts.len()];
        for d in parsed.data {
            if d.index < 0 || d.index as usize >= texts.len() || d.embedding.is_empty() {
                return Err("embeddings: a vector without a valid index".into());
            }
            vecs[d.index as usize] = d.embedding;
        }
        Ok(vecs)
    }
}

impl Embedder for OpenAiEmbedder {
    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, String>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(texts.len());
            for batch in texts.chunks(MAX_BATCH) {
                out.extend(self.embed_batch(batch).await?);
            }
            Ok(out)
        })
    }
}

/// s cut to n bytes (on a character boundary), marked when cut.
pub fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut end = n;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, http::HeaderMap, http::StatusCode, routing::post};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn openai_embedder() {
        let got = Arc::new(Mutex::new(serde_json::Value::Null));
        let seen = got.clone();
        let app = Router::new().route("/v1/embeddings", post(move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
            let seen = seen.clone();
            async move {
                if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer k") {
                    return (StatusCode::UNAUTHORIZED, "no".to_string());
                }
                let broken = body["model"] == "broken";
                *seen.lock().unwrap() = body;
                if broken {
                    return (StatusCode::NOT_FOUND, r#"{"error":"model not found"}"#.to_string());
                }
                // Out of order, as some servers answer.
                (StatusCode::OK, r#"{"data":[{"index":1,"embedding":[0,1]},{"index":0,"embedding":[1,0]}]}"#.to_string())
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let outcomes = Arc::new(Mutex::new(Vec::<String>::new()));
        let o = outcomes.clone();
        let mut e = OpenAiEmbedder::new(url, "k".into(), "m".into(), 2);
        e.observe = Some(Box::new(move |outcome, _| o.lock().unwrap().push(outcome.into())));
        let vecs = e.embed(&["a".into(), "b".into()]).await.unwrap();
        assert_eq!(vecs, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
        {
            let got = got.lock().unwrap();
            assert!(got["dimensions"] == 2 && got["encoding_format"] == "float", "request {got}");
        }
        e.model = "broken".into();
        let err = e.embed(&["a".into()]).await.unwrap_err();
        assert!(err.contains("answered 404"), "error {err}");
        assert_eq!(*outcomes.lock().unwrap(), ["ok", "error"]);
    }
}
