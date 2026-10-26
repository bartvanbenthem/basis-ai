//! YAML out the way Go's gopkg.in/yaml.v3 encoder writes it (SetIndent(2)),
//! so generated files keep their exact bytes: keys in yaml.v3's natural
//! order, sequences indented under their key, strings plain when that reads
//! back as the same string, else single- or double-quoted, multi-line ones
//! as literal blocks, no line folding.

use function_basis::common::gojson::fmt_g;
use regex::Regex;
use serde_json::Value;
use std::cmp::Ordering;
use std::sync::LazyLock;

/// One document, as yaml.v3 encodes Go values: map keys sorted.
pub fn encode(v: &Value) -> String {
    encode_node(&Node::from(v))
}

/// Documents as one stream, "---" between them (an Encoder's Encode calls).
pub fn encode_all<'a>(docs: impl IntoIterator<Item = &'a Value>) -> String {
    let mut out = String::new();
    for (i, d) in docs.into_iter().enumerate() {
        if i > 0 {
            out.push_str("---\n");
        }
        out.push_str(&encode(d));
    }
    out
}

/// One document from a node tree, as yaml.v3 encodes a yaml.Node: in its
/// order, each scalar in its own style where the emitter can write it so.
pub fn encode_node(n: &Node) -> String {
    let mut out = String::new();
    node(&mut out, n, 0, Ctx::Top);
    out
}

/// A YAML node: mappings in order, scalars with the style they ask for.
#[derive(Debug, Clone)]
pub enum Node {
    Map(Vec<(Node, Node)>),
    Seq(Vec<Node>),
    Scalar(String, Style),
}

impl From<&Value> for Node {
    /// A Go value's node: map keys in yaml.v3's order, strings in the style
    /// its encoder picks (see str_style).
    fn from(v: &Value) -> Node {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort_by(|a, b| natural(a, b));
                Node::Map(keys.into_iter().map(|k| (Node::Scalar(k.clone(), str_style(k)), Node::from(&m[k.as_str()]))).collect())
            }
            Value::Array(l) => Node::Seq(l.iter().map(Node::from).collect()),
            Value::String(s) => Node::Scalar(s.clone(), str_style(s)),
            Value::Null => Node::Scalar("null".into(), Style::Plain),
            Value::Bool(b) => Node::Scalar(b.to_string(), Style::Plain),
            Value::Number(n) => Node::Scalar(
                match n.as_f64() {
                    _ if n.is_i64() || n.is_u64() => n.to_string(),
                    Some(f) => fmt_g(f),
                    None => n.to_string(),
                },
                Style::Plain,
            ),
        }
    }
}

/// The style yaml.v3's encoder asks for a Go string: literal (multi-line),
/// plain (reads back as this string) or double-quoted.
pub fn str_style(s: &str) -> Style {
    if s.contains('\n') {
        Style::Literal
    } else if resolves_to_str(s) && !is_base60_float(s) && !is_old_bool(s) {
        Style::Plain
    } else {
        Style::Double
    }
}

/// Where a node starts: a document of its own, after "key:", or after "- ".
#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    Top,
    Value,
    Item,
}

fn indent(out: &mut String, n: usize) {
    out.extend(std::iter::repeat_n(' ', n));
}

/// Writes n, whose block content goes at column col. The caller wrote what
/// comes before it on its line ("key:", "- ", or nothing).
fn node(out: &mut String, n: &Node, col: usize, ctx: Ctx) {
    // The first entry continues the caller's line after "- ", or starts a
    // new one after "key:".
    let start = |out: &mut String, i: usize| match (ctx, i) {
        (Ctx::Item, 0) => {}
        (Ctx::Value, 0) => {
            out.push('\n');
            indent(out, col);
        }
        _ => indent(out, col),
    };
    match n {
        Node::Map(m) if !m.is_empty() => {
            for (i, (k, v)) in m.iter().enumerate() {
                start(out, i);
                out.push_str(&scalar(k, col, true));
                out.push(':');
                node(out, v, col + 2, Ctx::Value);
            }
        }
        Node::Seq(l) if !l.is_empty() => {
            for (i, e) in l.iter().enumerate() {
                start(out, i);
                out.push_str("- ");
                node(out, e, col + 2, Ctx::Item);
            }
        }
        _ => {
            if ctx == Ctx::Value {
                out.push(' ');
            }
            out.push_str(&scalar(n, col, false));
            out.push('\n');
        }
    }
}

/// A scalar (or empty collection) as it goes on its line; a literal block's
/// lines are indented at col.
fn scalar(n: &Node, col: usize, key: bool) -> String {
    match n {
        Node::Seq(_) => "[]".into(),
        Node::Map(_) => "{}".into(),
        Node::Scalar(s, style) => styled(s, *style, col, key),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Style {
    Plain,
    Single,
    Double,
    Literal,
}

/// s in the style asked for, unless the emitter can't carry the text that
/// way: then single quotes instead of plain, double quotes instead of
/// single quotes or a literal block.
fn styled(s: &str, mut style: Style, col: usize, key: bool) -> String {
    let a = analyze(s);
    if style == Style::Plain && (!a.block_plain_allowed || (s.is_empty() && key)) {
        style = Style::Single;
    }
    if style == Style::Single && !a.single_quoted_allowed {
        style = Style::Double;
    }
    if style == Style::Literal && (!a.block_allowed || key) {
        style = Style::Double;
    }
    match style {
        Style::Plain => s.to_string(),
        Style::Single => format!("'{}'", s.replace('\'', "''")),
        Style::Double => double_quoted(s),
        Style::Literal => literal(s, col),
    }
}

fn literal(s: &str, col: usize) -> String {
    let mut out = String::from("|");
    if s.starts_with([' ', '\n', '\r']) {
        out.push('2');
    }
    let trailing = s.len() - s.trim_end_matches(['\n', '\r']).len();
    match trailing {
        0 => out.push('-'),
        1 if s.len() > 1 => {}
        _ => out.push('+'),
    }
    out.push('\n');
    let body = s.strip_suffix('\n').unwrap_or(s);
    for line in body.split('\n') {
        if !line.is_empty() {
            indent(&mut out, col);
            out.push_str(line);
        }
        out.push('\n');
    }
    // The final newline is the caller's.
    out.pop();
    out
}

fn double_quoted(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        if !printable(c) || c == '\u{feff}' || is_break(c) || c == '"' || c == '\\' {
            out.push('\\');
            match c {
                '\0' => out.push('0'),
                '\u{07}' => out.push('a'),
                '\u{08}' => out.push('b'),
                '\t' => out.push('t'),
                '\n' => out.push('n'),
                '\u{0b}' => out.push('v'),
                '\u{0c}' => out.push('f'),
                '\r' => out.push('r'),
                '\u{1b}' => out.push('e'),
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                '\u{85}' => out.push('N'),
                '\u{a0}' => out.push('_'),
                '\u{2028}' => out.push('L'),
                '\u{2029}' => out.push('P'),
                c if (c as u32) <= 0xff => out.push_str(&format!("x{:02X}", c as u32)),
                c if (c as u32) <= 0xffff => out.push_str(&format!("u{:04X}", c as u32)),
                c => out.push_str(&format!("U{:08X}", c as u32)),
            }
        } else {
            out.push(c);
        }
    }
    out.push('"');
    out
}

/// libyaml's printable set, as yaml.v3 checks it (4-byte characters aren't).
fn printable(c: char) -> bool {
    matches!(c as u32, 0x0a | 0x20..=0x7e | 0xa0..=0xd7ff | 0xe000..=0xfffd) && c != '\u{feff}'
}

fn is_break(c: char) -> bool {
    matches!(c, '\r' | '\n' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

fn is_blank(c: Option<char>) -> bool {
    matches!(c, Some(' ' | '\t'))
}

fn is_blankz(c: Option<char>) -> bool {
    match c {
        None | Some('\0') => true,
        Some(c) => c == ' ' || c == '\t' || is_break(c),
    }
}

struct Analysis {
    block_plain_allowed: bool,
    single_quoted_allowed: bool,
    block_allowed: bool,
}

/// yaml_emitter_analyze_scalar, for the block context.
fn analyze(s: &str) -> Analysis {
    if s.is_empty() {
        return Analysis { block_plain_allowed: true, single_quoted_allowed: true, block_allowed: false };
    }
    let mut block_indicators = s.starts_with("---") || s.starts_with("...");
    let (mut leading_space, mut leading_break, mut trailing_space, mut trailing_break) = (false, false, false, false);
    let (mut break_space, mut space_break, mut previous_space, mut previous_break) = (false, false, false, false);
    let (mut line_breaks, mut special) = (false, false);
    let mut preceded_by_whitespace = true;
    let chars: Vec<char> = s.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        let next = chars.get(i + 1).copied();
        let followed_by_whitespace = next.is_none() || is_blank(next) || next.is_some_and(is_break);
        let last = i + 1 == chars.len();
        if i == 0 {
            match c {
                '#' | ',' | '[' | ']' | '{' | '}' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%' | '@' | '`' => block_indicators = true,
                '?' | ':' if followed_by_whitespace => block_indicators = true,
                '-' if followed_by_whitespace => block_indicators = true,
                _ => {}
            }
        } else {
            match c {
                ':' if followed_by_whitespace => block_indicators = true,
                '#' if preceded_by_whitespace => block_indicators = true,
                _ => {}
            }
        }
        if !printable(c) {
            special = true;
        }
        if c == ' ' {
            if i == 0 {
                leading_space = true;
            }
            if last {
                trailing_space = true;
            }
            if previous_break {
                break_space = true;
            }
            previous_space = true;
            previous_break = false;
        } else if is_break(c) {
            line_breaks = true;
            if i == 0 {
                leading_break = true;
            }
            if last {
                trailing_break = true;
            }
            if previous_space {
                space_break = true;
            }
            previous_space = false;
            previous_break = true;
        } else {
            previous_space = false;
            previous_break = false;
        }
        preceded_by_whitespace = is_blankz(Some(c));
    }
    let mut a = Analysis { block_plain_allowed: true, single_quoted_allowed: true, block_allowed: true };
    if leading_space || leading_break || trailing_space || trailing_break {
        a.block_plain_allowed = false;
    }
    if trailing_space {
        a.block_allowed = false;
    }
    if break_space {
        a.block_plain_allowed = false;
        a.single_quoted_allowed = false;
    }
    if space_break || special {
        a.block_plain_allowed = false;
        a.single_quoted_allowed = false;
        a.block_allowed = false;
    }
    if line_breaks || block_indicators {
        a.block_plain_allowed = false;
    }
    a
}

static YAML_STYLE_FLOAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$").unwrap());
static BASE60_FLOAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$").unwrap());
static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(([Tt][0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]+)?(Z|[-+][0-9]{2}:[0-9]{2}))|( [0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]+)?))?$").unwrap()
});

fn is_base60_float(s: &str) -> bool {
    !s.is_empty() && BASE60_FLOAT.is_match(s)
}

fn is_old_bool(s: &str) -> bool {
    matches!(s, "y" | "Y" | "yes" | "Yes" | "YES" | "on" | "On" | "ON" | "n" | "N" | "no" | "No" | "NO" | "off" | "Off" | "OFF")
}

/// Go's strconv.ParseInt/ParseUint with base 0, sign and prefixes.
fn parses_as_int(s: &str) -> bool {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    let (radix, body) = if let Some(b) = digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")) {
        (16, b)
    } else if let Some(b) = digits.strip_prefix("0o").or_else(|| digits.strip_prefix("0O")) {
        (8, b)
    } else if let Some(b) = digits.strip_prefix("0b").or_else(|| digits.strip_prefix("0B")) {
        (2, b)
    } else if digits.len() > 1 && digits.starts_with('0') {
        (8, &digits[1..])
    } else {
        (10, digits)
    };
    !body.is_empty() && u64::from_str_radix(body, radix).is_ok()
}

/// Go's strconv.ParseFloat succeeds: an overflow (08332717038e4651) is its
/// range error, where Rust reads infinity.
fn go_float(s: &str) -> bool {
    s.parse::<f64>().is_ok_and(f64::is_finite)
}

/// yaml.v3's resolve: whether a plain scalar reads back as a string. Only
/// scalars starting with a sign, digit, dot or one of "yYnNtTfFoO~" (or
/// empty) are looked up at all.
pub fn resolves_to_str(s: &str) -> bool {
    if matches!(s, "true" | "True" | "TRUE" | "false" | "False" | "FALSE" | "" | "~" | "null" | "Null" | "NULL"
        | ".nan" | ".NaN" | ".NAN" | ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" | "-.inf" | "-.Inf" | "-.INF"
        | "-0" | "-0.0")
    {
        return false;
    }
    match s.as_bytes()[0] {
        b'.' => !go_float(s),
        b'+' | b'-' | b'0'..=b'9' => {
            if TIMESTAMP.is_match(s) {
                return false;
            }
            let plain = s.replace('_', "");
            !(parses_as_int(&plain) || (YAML_STYLE_FLOAT.is_match(&plain) && go_float(&plain)))
        }
        _ => true,
    }
}

/// yaml.v3's key order (keyList.Less): runs of digits compare as numbers,
/// letters before other characters.
pub fn natural(a: &str, b: &str) -> Ordering {
    let (ar, br): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let less = |x: &[char], y: &[char]| -> bool {
        let mut digits = false;
        let n = x.len().min(y.len());
        for i in 0..n {
            if x[i] == y[i] {
                digits = x[i].is_ascii_digit();
                continue;
            }
            let (al, bl) = (x[i].is_alphabetic(), y[i].is_alphabetic());
            if al && bl {
                return x[i] < y[i];
            }
            if al || bl {
                return if digits { al } else { bl };
            }
            let (mut an, mut bn): (i64, i64) = (0, 0);
            if x[i] == '0' || y[i] == '0' {
                let mut j = i;
                while j > 0 && x[j - 1].is_ascii_digit() {
                    j -= 1;
                    if x[j] != '0' {
                        an = 1;
                        bn = 1;
                        break;
                    }
                }
            }
            let mut ai = i;
            while ai < x.len() && x[ai].is_ascii_digit() {
                an = an.wrapping_mul(10).wrapping_add(x[ai] as i64 - '0' as i64);
                ai += 1;
            }
            let mut bi = i;
            while bi < y.len() && y[bi].is_ascii_digit() {
                bn = bn.wrapping_mul(10).wrapping_add(y[bi] as i64 - '0' as i64);
                bi += 1;
            }
            if an != bn {
                return an < bn;
            }
            if ai != bi {
                return ai < bi;
            }
            return x[i] < y[i];
        }
        x.len() < y.len()
    };
    if less(&ar, &br) {
        Ordering::Less
    } else if less(&br, &ar) {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// The documents of a YAML stream as node trees, each scalar with the style
/// it was written in (yaml.v3's yaml.Node). Folded scalars come back as
/// literal ones; aliases aren't supported.
pub fn parse_nodes(text: &str) -> Result<Vec<Node>, String> {
    use yaml_rust2::parser::{Event, EventReceiver, Parser};
    use yaml_rust2::scanner::TScalarStyle;

    #[derive(Default)]
    struct Builder {
        docs: Vec<Node>,
        stack: Vec<Node>,
        keys: Vec<Option<Node>>,
        error: Option<String>,
    }

    impl Builder {
        fn add(&mut self, n: Node) {
            match self.stack.last_mut() {
                None => self.docs.push(n),
                Some(Node::Seq(l)) => l.push(n),
                Some(Node::Map(m)) => match self.keys.last_mut().and_then(Option::take) {
                    None => *self.keys.last_mut().unwrap() = Some(n),
                    Some(k) => m.push((k, n)),
                },
                Some(Node::Scalar(..)) => unreachable!("a scalar on the stack"),
            }
        }
    }

    impl EventReceiver for Builder {
        fn on_event(&mut self, ev: Event) {
            match ev {
                Event::Scalar(v, style, _, _) => {
                    let style = match style {
                        TScalarStyle::Plain => Style::Plain,
                        TScalarStyle::SingleQuoted => Style::Single,
                        TScalarStyle::DoubleQuoted => Style::Double,
                        TScalarStyle::Literal | TScalarStyle::Folded => Style::Literal,
                    };
                    self.add(Node::Scalar(v, style));
                }
                Event::SequenceStart(..) => self.stack.push(Node::Seq(vec![])),
                Event::MappingStart(..) => {
                    self.stack.push(Node::Map(vec![]));
                    self.keys.push(None);
                }
                Event::SequenceEnd | Event::MappingEnd => {
                    if matches!(ev, Event::MappingEnd) {
                        self.keys.pop();
                    }
                    let n = self.stack.pop().expect("a collection to end");
                    self.add(n);
                }
                Event::Alias(_) => self.error = Some("YAML aliases aren't supported".into()),
                _ => {}
            }
        }
    }

    let mut b = Builder::default();
    Parser::new_from_str(text).load(&mut b, true).map_err(|e| e.to_string())?;
    match b.error {
        Some(e) => Err(e),
        None => Ok(b.docs),
    }
}

impl Node {
    /// The node at a path of mapping keys and sequence indexes.
    pub fn lookup(&self, path: &[crate::doc::Key]) -> Option<&Node> {
        path.iter().try_fold(self, |n, k| n.child(k))
    }

    pub fn lookup_mut(&mut self, path: &[crate::doc::Key]) -> Option<&mut Node> {
        let mut n = self;
        for k in path {
            n = match (n, k) {
                (Node::Map(m), crate::doc::Key::S(s)) => m.iter_mut().find(|(key, _)| key.text() == Some(s)).map(|(_, v)| v)?,
                (Node::Seq(l), crate::doc::Key::I(i)) => l.get_mut(*i)?,
                _ => return None,
            };
        }
        Some(n)
    }

    fn child(&self, k: &crate::doc::Key) -> Option<&Node> {
        match (self, k) {
            (Node::Map(m), crate::doc::Key::S(s)) => m.iter().find(|(key, _)| key.text() == Some(s)).map(|(_, v)| v),
            (Node::Seq(l), crate::doc::Key::I(i)) => l.get(*i),
            _ => None,
        }
    }

    /// A scalar's text.
    pub fn text(&self) -> Option<&str> {
        match self {
            Node::Scalar(s, _) => Some(s),
            _ => None,
        }
    }

    /// A scalar that reads back as a string (yaml.v3's !!str tag).
    pub fn is_str(&self) -> bool {
        match self {
            Node::Scalar(s, Style::Plain) => resolves_to_str(s),
            Node::Scalar(..) => true,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn styles() {
        // As gopkg.in/yaml.v3 writes it (checked against Go).
        let doc = json!({
            "plain": "a b", "colon": "a: b", "hash": "a #b", "empty": "", "num": "18", "float": "1.5", "bool": "true",
            "yes": "yes", "date": "2026-01-01", "multi": "a\n\nb", "multi_nl": "a\n", "quote": "it's: x", "tab": "a\tb",
            "dash": "- a", "star": "*a", "ref": "#/components", "path": "/apis/{name}", "int": 3, "f": 0.5, "big": 1e6,
            "seq": ["x", {"k": 1, "j": [1, 2]}], "map": {"b": true}, "emptyseq": [], "emptymap": {}, "null": null,
            "b10": 1, "b9": 1, "a": 1, "B": 1, "_x": 1, "x_": 1, "xA": 1, "200": 1, "401": 1, "$ref": 1, "emoji": "hi \u{1F600}",
            "lead": " x", "trail": "x ", "multitrail": "a \nb", "x08": "0755", "hex": "0x1F", "e": "1e3", "dot": ".5", "minus": "-",
            "q": "?", "excl": "!x", "pct": "50%", "at": "@x", "tick": "`x", "co": "a:b", "colonend": "a:", "under": "1_000",
            "inf": ".inf", "tilde": "~", "nul": "null", "lt": "<<", "hash16": "08332717038e4651",
        });
        let want = include_str!("../testdata/yaml-styles.yaml");
        assert_eq!(encode(&doc), want);
    }

    #[test]
    fn key_order() {
        let mut keys = vec!["b10", "b9", "a", "B", "_x", "x_", "x08", "xA", "200", "401", "$ref"];
        keys.sort_by(|a, b| natural(a, b));
        assert_eq!(keys, ["$ref", "_x", "200", "401", "B", "a", "b9", "b10", "x_", "x08", "xA"]);
    }
}
