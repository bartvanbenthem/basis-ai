//! Kubernetes-style YAML as serde_json values, walked without a type check
//! at every step: a missing key or a value of the wrong type reads as
//! nothing, like Python's dict.get.

use function_basis::common::gojson;
use serde::Deserialize;
use serde_json::{Map, Value};

/// A step of a path: a mapping key or a sequence index.
pub enum Key<'a> {
    S(&'a str),
    I(usize),
}

impl<'a> From<&'a str> for Key<'a> {
    fn from(s: &'a str) -> Self {
        Key::S(s)
    }
}

impl<'a> From<&'a String> for Key<'a> {
    fn from(s: &'a String) -> Self {
        Key::S(s)
    }
}

impl From<usize> for Key<'_> {
    fn from(i: usize) -> Self {
        Key::I(i)
    }
}

/// Follows a path of keys and indexes; None as soon as a step doesn't exist.
pub fn get<'v>(v: &'v Value, path: &[Key]) -> Option<&'v Value> {
    let mut v = v;
    for k in path {
        v = match k {
            Key::S(s) => v.as_object()?.get(*s)?,
            Key::I(i) => v.as_array()?.get(*i)?,
        };
    }
    Some(v)
}

/// get(v, path), the path as arguments: at!(d, "spec", "items", 0).
#[macro_export]
macro_rules! at {
    ($v:expr $(, $k:expr)* $(,)?) => {
        $crate::doc::get($v, &[$($crate::doc::Key::from($k)),*])
    };
}

/// The string at a path; "" when absent or not a string.
#[macro_export]
macro_rules! s {
    ($v:expr $(, $k:expr)* $(,)?) => {
        $crate::at!($v $(, $k)*).and_then(serde_json::Value::as_str).unwrap_or("")
    };
}

/// The mapping at a path, if there is one.
#[macro_export]
macro_rules! m {
    ($v:expr $(, $k:expr)* $(,)?) => {
        $crate::at!($v $(, $k)*).and_then(serde_json::Value::as_object)
    };
}

/// The sequence at a path; empty when absent.
#[macro_export]
macro_rules! l {
    ($v:expr $(, $k:expr)* $(,)?) => {
        $crate::at!($v $(, $k)*).and_then(serde_json::Value::as_array).map(Vec::as_slice).unwrap_or(&[])
    };
}

/// Whether the mapping at a path has a key: has!(v, key, path...). The key
/// comes first, as in the Go helper it replaces.
#[macro_export]
macro_rules! has {
    ($v:expr, $key:expr $(, $k:expr)* $(,)?) => {
        $crate::m!($v $(, $k)*).is_some_and(|m| m.contains_key($key))
    };
}

/// Every non-empty document of multi-document YAML.
pub fn decode_all(text: &str) -> Result<Vec<Value>, String> {
    let mut docs = vec![];
    for d in serde_yaml::Deserializer::from_str(text) {
        let v = Value::deserialize(d).map_err(|e| e.to_string())?;
        if !v.is_null() {
            docs.push(v);
        }
    }
    Ok(docs)
}

/// Every non-empty document of a multi-document YAML file.
pub fn load_all(path: &str) -> Result<Vec<Value>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    decode_all(&text).map_err(|e| format!("{path}: {e}"))
}

/// A single YAML (or JSON) document.
pub fn load(path: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_yaml::from_str(&text).map_err(|e| format!("{path}: {e}"))
}

/// A mapping's keys, sorted.
pub fn keys(m: &Map<String, Value>) -> Vec<&str> {
    let mut k: Vec<&str> = m.keys().map(String::as_str).collect();
    k.sort();
    k
}

/// Structural equality where numbers compare by value (YAML 2 equals 2.0).
pub fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| equal(v, w))),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(v, w)| equal(v, w)),
        _ => a == b,
    }
}

/// An integer (not a float that happens to be whole).
pub fn is_int(v: &Value) -> bool {
    v.as_number().is_some_and(|n| n.is_i64() || n.is_u64())
}

/// A value, compactly, for failure messages.
pub fn repr(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(s)) => gojson::quote(s),
        Some(v) => gojson::marshal(v),
    }
}

/// Every key and string value under v, for text searches.
pub fn all_strings(v: &Value) -> String {
    fn walk(v: &Value, b: &mut String) {
        match v {
            Value::Object(m) => {
                for k in keys(m) {
                    b.push_str(k);
                    b.push('\n');
                    walk(&m[k], b);
                }
            }
            Value::Array(l) => l.iter().for_each(|e| walk(e, b)),
            Value::String(s) => {
                b.push_str(s);
                b.push('\n');
            }
            _ => {}
        }
    }
    let mut b = String::new();
    walk(v, &mut b);
    b
}

/// The strings of a sequence.
pub fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

/// The api directory.
pub fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("the api directory").to_path_buf()
}
