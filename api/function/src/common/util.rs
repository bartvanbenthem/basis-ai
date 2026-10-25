//! Small helpers every composition shares: reading unstructured objects,
//! hashing, generated secrets and the clock (both replaceable in tests).

use base64::Engine as _;
use rand::Rng;
use serde_json::{Map, Value};
use sha1::Digest as _;
use std::cell::RefCell;

/// A Kubernetes object as unstructured JSON.
pub type Object = Value;

/// The value at path, if every step is an object that has it.
pub fn dig<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for p in path {
        cur = cur.as_object()?.get(*p)?;
    }
    Some(cur)
}

/// dig on an optional object.
pub fn dig_opt<'a>(v: Option<&'a Value>, path: &[&str]) -> Option<&'a Value> {
    v.and_then(|v| dig(v, path))
}

/// The string at path, "" when it isn't one (Go's `x, _ := v.(string)`).
pub fn dig_str<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    dig(v, path).and_then(Value::as_str).unwrap_or("")
}

/// The string a value is, "" otherwise.
pub fn as_str(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

/// The object a value is, an empty one otherwise.
pub fn as_obj(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// The boolean a value is, def otherwise.
pub fn bool_or(v: Option<&Value>, def: bool) -> bool {
    v.and_then(Value::as_bool).unwrap_or(def)
}

/// v, or def when v is empty.
pub fn or<'a>(v: &'a str, def: &'a str) -> &'a str {
    if v.is_empty() { def } else { v }
}

/// n, or def when n is zero.
pub fn or_i(n: i64, def: i64) -> i64 {
    if n == 0 { def } else { n }
}

/// f, or def when f is zero.
pub fn or_f(f: f64, def: f64) -> f64 {
    if f == 0.0 { def } else { f }
}

/// The status condition of type t of an object.
pub fn condition<'a>(obj: Option<&'a Value>, t: &str) -> Option<&'a Map<String, Value>> {
    dig_opt(obj, &["status", "conditions"])?
        .as_array()?
        .iter()
        .filter_map(Value::as_object)
        .find(|c| c.get("type").and_then(Value::as_str) == Some(t))
}

pub fn condition_true(obj: Option<&Value>, t: &str) -> bool {
    condition(obj, t).is_some_and(|c| c.get("status").and_then(Value::as_str) == Some("True"))
}

/// The manifest a provider-kubernetes Object's location reports.
pub fn live(o: Option<&Value>) -> Option<&Value> {
    dig_opt(o, &["status", "atProvider", "manifest"]).filter(|m| m.as_object().is_some_and(|m| !m.is_empty()))
}

/// The location reports the Object's manifest.
pub fn reported(o: Option<&Value>) -> bool {
    live(o).is_some()
}

pub fn sha1hex(s: &str) -> String {
    hex::encode(sha1::Sha1::digest(s.as_bytes()))
}

pub fn sha256hex(s: &str) -> String {
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

pub fn b64(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

/// Decodes base64, None when it isn't.
pub fn unb64(s: &str) -> Option<String> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
}

/// The first n bytes of s.
pub fn trunc(s: &str, n: usize) -> &str {
    if s.len() > n { &s[..n] } else { s }
}

/// Labels as a JSON object.
pub fn labels_obj(labels: &[(&str, &str)]) -> Map<String, Value> {
    labels.iter().map(|(k, v)| (k.to_string(), Value::String(v.to_string()))).collect()
}

thread_local! {
    static SECRET: RefCell<Option<String>> = const { RefCell::new(None) };
    static NOW: RefCell<Option<chrono::DateTime<chrono::Utc>>> = const { RefCell::new(None) };
}

/// A generated key or password: n letters and digits.
pub fn new_secret(n: usize) -> String {
    if let Some(s) = SECRET.with(|s| s.borrow().clone()) {
        return s;
    }
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut rng = rand::rng();
    (0..n).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
}

/// Tests: every generated secret is s from now on (this thread).
pub fn set_secret(s: Option<&str>) {
    SECRET.with(|v| *v.borrow_mut() = s.map(str::to_string));
}

/// The compositions' clock.
pub fn now() -> chrono::DateTime<chrono::Utc> {
    NOW.with(|n| *n.borrow()).unwrap_or_else(chrono::Utc::now)
}

/// Tests: the clock stands at t (this thread); None restores it.
pub fn set_now(t: Option<chrono::DateTime<chrono::Utc>>) {
    NOW.with(|n| *n.borrow_mut() = t);
}

/// A YYYY-MM-DD date has passed: its last day (UTC) is over.
pub fn past_day(date: &str) -> bool {
    match chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        Ok(d) if date.len() == 10 => {
            let end = d.and_hms_opt(0, 0, 0).expect("midnight").and_utc() + chrono::Duration::hours(24);
            now() >= end
        }
        _ => false,
    }
}
