//! What Go's encoding/json, strconv and fmt write, for the strings the
//! compositions embed in objects: a dashboard's JSON, basis-mcp's
//! config.json (whose hash rolls the pods), PromQL with thresholds. The
//! objects themselves go to Crossplane as protobuf Structs, where formatting
//! doesn't matter; these strings must come out byte for byte as function-basis
//! wrote them in Go, or every dashboard and server would change on upgrade.

use serde_json::Value;
use std::fmt::Write as _;

/// json.Marshal: keys sorted (serde_json's map is ordered), Go's escaping
/// and number formatting.
pub fn marshal(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v, None, 0);
    out
}

/// json.MarshalIndent(v, "", indent).
pub fn marshal_indent(v: &Value, indent: &str) -> String {
    let mut out = String::new();
    write_value(&mut out, v, Some(indent), 0);
    out
}

fn newline(out: &mut String, indent: Option<&str>, level: usize) {
    if let Some(ind) = indent {
        out.push('\n');
        for _ in 0..level {
            out.push_str(ind);
        }
    }
}

fn write_value(out: &mut String, v: &Value, indent: Option<&str>, level: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n),
        Value::String(s) => write_string(out, s),
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write_value(out, e, indent, level + 1);
            }
            newline(out, indent, level);
            out.push(']');
        }
        Value::Object(m) => {
            if m.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, e)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write_string(out, k);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, e, indent, level + 1);
            }
            newline(out, indent, level);
            out.push('}');
        }
    }
}

fn write_number(out: &mut String, n: &serde_json::Number) {
    if let Some(i) = n.as_i64() {
        let _ = write!(out, "{i}");
    } else if let Some(u) = n.as_u64() {
        let _ = write!(out, "{u}");
    } else if let Some(f) = n.as_f64() {
        out.push_str(&json_float(f));
    }
}

/// encoding/json's float64: 'f' formatting, or 'e' for very small and very
/// large magnitudes with a two-digit exponent's leading zero dropped.
fn json_float(f: f64) -> String {
    let abs = f.abs();
    if abs != 0.0 && !(1e-6..1e21).contains(&abs) {
        let s = format_e(&shortest(f), None);
        // "1e-07" -> "1e-7", as Go does.
        if let Some(i) = s.find("e-0") {
            return format!("{}e-{}", &s[..i], &s[i + 3..]);
        }
        return s;
    }
    format_f(&shortest(f), None)
}

/// Go's string escaping: ", \ and control characters, plus <, > and & (HTML
/// safe) and U+2028, U+2029.
pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---- strconv.FormatFloat

/// A float's decimal digits (no trailing zeros) and the decimal point's
/// position: value = 0.d1d2... * 10^dp.
struct Digits {
    neg: bool,
    d: Vec<u8>,
    dp: i32,
}

/// Parses Rust's "{:e}" output ("-1.2345e-7", "5e6", "0e0").
fn digits_from_exp(s: &str) -> Digits {
    let (neg, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (mant, exp) = s.split_once('e').unwrap_or((s, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let mut d: Vec<u8> = mant.bytes().filter(|b| b.is_ascii_digit()).collect();
    while d.len() > 1 && d.last() == Some(&b'0') {
        d.pop();
    }
    if d == b"0" {
        return Digits { neg, d: vec![], dp: 0 };
    }
    Digits { neg, d, dp: exp + 1 }
}

/// The shortest digits that round-trip (Rust's and Go's shortest agree).
fn shortest(f: f64) -> Digits {
    digits_from_exp(&format!("{f:e}"))
}

/// Digits rounded to prec significant digits.
fn rounded(f: f64, prec: usize) -> Digits {
    digits_from_exp(&format!("{:.*e}", prec.saturating_sub(1), f))
}

/// %e: d.ddde±XX with prec digits after the point (None: all the digits).
fn format_e(dg: &Digits, prec: Option<usize>) -> String {
    let mut s = String::new();
    if dg.neg {
        s.push('-');
    }
    let first = dg.d.first().copied().unwrap_or(b'0');
    s.push(first as char);
    let rest: Vec<u8> = dg.d.iter().skip(1).copied().collect();
    let prec = prec.unwrap_or(rest.len());
    if prec > 0 {
        s.push('.');
        for i in 0..prec {
            s.push(*rest.get(i).unwrap_or(&b'0') as char);
        }
    }
    let exp = if dg.d.is_empty() { 0 } else { dg.dp - 1 };
    let _ = write!(s, "e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs());
    s
}

/// %f with prec digits after the point (None: as many as the digits need).
fn format_f(dg: &Digits, prec: Option<usize>) -> String {
    let mut s = String::new();
    if dg.neg {
        s.push('-');
    }
    let digit = |i: i32| -> char {
        if i >= 0 && (i as usize) < dg.d.len() {
            dg.d[i as usize] as char
        } else {
            '0'
        }
    };
    if dg.dp > 0 {
        for i in 0..dg.dp {
            s.push(digit(i));
        }
    } else {
        s.push('0');
    }
    let prec = prec.unwrap_or_else(|| (dg.d.len() as i32 - dg.dp).max(0) as usize);
    if prec > 0 {
        s.push('.');
        for i in 0..prec as i32 {
            s.push(digit(dg.dp + i));
        }
    }
    s
}

/// strconv.FormatFloat(f, 'g', -1, 64): what fmt's %v writes for a float64.
pub fn fmt_g(f: f64) -> String {
    let dg = shortest(f);
    if dg.d.is_empty() {
        return if f.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    let exp = dg.dp - 1;
    if !(-4..6).contains(&exp) {
        return format_e(&dg, None);
    }
    format_f(&dg, None)
}

/// strconv.FormatFloat(f, 'g', prec, 64).
pub fn fmt_g_prec(f: f64, prec: usize) -> String {
    let prec = prec.max(1);
    let dg = rounded(f, prec);
    if dg.d.is_empty() {
        return "0".into();
    }
    let nd = dg.d.len() as i32;
    let mut eprec = prec as i32;
    if eprec > nd && nd >= dg.dp {
        eprec = nd;
    }
    let exp = dg.dp - 1;
    if exp < -4 || exp >= eprec {
        let p = (prec as i32).min(nd);
        return format_e(&dg, Some((p - 1).max(0) as usize));
    }
    let p = if prec as i32 > dg.dp { nd } else { prec as i32 };
    format_f(&dg, Some((p - dg.dp).max(0) as usize))
}

/// strconv.FormatFloat(f, 'f', -1, 64).
pub fn fmt_f(f: f64) -> String {
    format_f(&shortest(f), None)
}

/// fmt.Sprint of a value decoded from JSON: strings as they are, numbers
/// (float64 in Go) with %v, booleans, nil as "<nil>".
pub fn sprint(v: &Value) -> String {
    match v {
        Value::Null => "<nil>".into(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_i64() {
            Some(i) if (i as f64).abs() < 1e21 => fmt_g(i as f64),
            _ => fmt_g(n.as_f64().unwrap_or(0.0)),
        },
        Value::Array(a) => format!("[{}]", a.iter().map(sprint).collect::<Vec<_>>().join(" ")),
        Value::Object(m) => format!(
            "map[{}]",
            m.iter().map(|(k, v)| format!("{k}:{}", sprint(v))).collect::<Vec<_>>().join(" ")
        ),
    }
}

/// strconv.Quote, as %q writes it, for the ASCII names it quotes into PromQL.
pub fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\u{b}' => out.push_str("\\v"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// regexp.QuoteMeta: a backslash before \.+*?()|[]{}^$ (regex::escape
/// escapes more, e.g. "-").
pub fn quote_meta(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_floats_like_go() {
        for (f, want) in [
            (5.0, "5"),
            (0.5, "0.5"),
            (95.0, "95"),
            (1e6, "1e+06"),
            (123456.0, "123456"),
            (1234567.0, "1.234567e+06"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (2.5, "2.5"),
            (-3.0, "-3"),
            (0.0, "0"),
        ] {
            assert_eq!(fmt_g(f), want, "fmt_g({f})");
        }
        for (f, want) in [
            (30.0 / 730.0, "0.04109589"),
            (0.5, "0.5"),
            (100.0, "100"),
            (1234567890.0, "1.2345679e+09"),
            (2.0 / 3.0, "0.66666667"),
            (12.5 / 730.0, "0.017123288"),
            (0.0, "0"),
        ] {
            assert_eq!(fmt_g_prec(f, 8), want, "fmt_g_prec({f})");
        }
        assert_eq!(fmt_f(100.0), "100");
        assert_eq!(fmt_f(1234.5), "1234.5");
        assert_eq!(fmt_f(1e21), "1000000000000000000000");
    }

    #[test]
    fn marshals_like_go() {
        let v = json!({"b": [1, 2.5, "x<y&z>"], "a": {}, "c": [], "d": null, "e": 1e-7, "f": 3.0});
        assert_eq!(marshal(&v), r#"{"a":{},"b":[1,2.5,"x\u003cy\u0026z\u003e"],"c":[],"d":null,"e":1e-7,"f":3}"#);
        assert_eq!(
            marshal_indent(&json!({"a": 1, "b": {"c": [true]}, "e": {}}), "  "),
            "{\n  \"a\": 1,\n  \"b\": {\n    \"c\": [\n      true\n    ]\n  },\n  \"e\": {}\n}"
        );
        assert_eq!(marshal(&json!("tab\tnl\n\u{1}")), r#""tab\tnl\n\u0001""#);
    }

    #[test]
    fn quotes_like_go() {
        assert_eq!(quote("ai-team"), "\"ai-team\"");
        assert_eq!(quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(quote_meta("httproute/ns/gw/rule/0"), "httproute/ns/gw/rule/0");
        assert_eq!(quote_meta("gpt-4.1 (x)"), "gpt-4\\.1 \\(x\\)");
        assert_eq!(sprint(&json!(1000000)), "1e+06");
        assert_eq!(sprint(&json!(3)), "3");
        assert_eq!(sprint(&json!("x")), "x");
        assert_eq!(sprint(&json!(true)), "true");
    }
}
