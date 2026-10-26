//! The clients' API keys: the files of a mounted Secret, one per client
//! (the file name is the client). The kubelet updates the files when the
//! Secret changes, so they're read again every interval: a removed or
//! expired client's key stops working without a restart.

use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;

pub struct Keys {
    dir: PathBuf,
    /// sha256 of a key and its client, so a lookup doesn't depend on the
    /// key's bytes (compared in constant time below).
    by_hash: RwLock<Vec<([u8; 32], String)>>,
}

fn hash(key: &str) -> [u8; 32] {
    Sha256::digest(key.as_bytes()).into()
}

impl Keys {
    /// Reads dir once; watch keeps it current.
    pub fn new(dir: impl Into<PathBuf>) -> std::io::Result<Keys> {
        let k = Keys { dir: dir.into(), by_hash: RwLock::default() };
        k.reload()?;
        Ok(k)
    }

    pub fn reload(&self) -> std::io::Result<()> {
        let mut by_hash = vec![];
        for e in std::fs::read_dir(&self.dir)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            // A Secret volume's own entries (..data, ..2026_...) start with a dot.
            if name.starts_with('.') || e.path().is_dir() {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(e.path()) else { continue };
            let key = raw.trim();
            if !key.is_empty() {
                by_hash.push((hash(key), name));
            }
        }
        *self.by_hash.write().unwrap() = by_hash;
        Ok(())
    }

    /// Reloads the keys every interval until stop.
    pub async fn watch(&self, interval: Duration, stop: CancellationToken, on_error: impl Fn(std::io::Error)) {
        let mut t = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
        loop {
            tokio::select! {
                _ = stop.cancelled() => return,
                _ = t.tick() => {
                    if let Err(e) = self.reload() {
                        on_error(e);
                    }
                }
            }
        }
    }

    /// The client a key belongs to, None for none.
    pub fn client(&self, key: &str) -> Option<String> {
        let h = hash(key);
        let by_hash = self.by_hash.read().unwrap();
        let mut found = None;
        for (known, client) in by_hash.iter() {
            if bool::from(known.ct_eq(&h)) {
                found = Some(client.clone());
            }
        }
        found
    }

    /// The number of clients with a key.
    pub fn len(&self) -> usize {
        self.by_hash.read().unwrap().len()
    }
}
