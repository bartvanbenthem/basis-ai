//! rendertest holds the parts of tests/render/run.sh that aren't shell:
//!
//! ```text
//! rendertest crds <helm-template-output.yaml> <out.yaml>
//!     keep only the CustomResourceDefinitions (the Barman Cloud chart ships them with the plugin)
//! rendertest objects <render-output.yaml> <out.yaml>
//!     the objects to schema-validate: no Function Results, no core kinds, plus
//!     the manifest inside every provider-kubernetes Object
//! rendertest stores <render-output.yaml> <observed-out.yaml>
//!     the observed state in which every composed ObjectStore is reported by its location
//! rendertest assert <api> <case> <empty|observed|stores> <render-output.yaml> [dashboard.json]
//!     semantic assertions on `crossplane render` output (postgrescluster.rs, project.rs,
//!     location.rs, valkeycache.rs, modelserver.rs, modelgateway.rs, mcpserver.rs, genaistack.rs)
//! ```

mod genaistack;
mod location;
mod mcpserver;
mod modelgateway;
mod modelserver;
mod postgrescluster;
mod project;
mod valkeycache;

use basis_tools::doc::{self, equal};
use basis_tools::{l, m, s, yaml};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

fn usage() -> ! {
    eprintln!("usage: rendertest crds <in.yaml> <out.yaml>
       rendertest objects <render.yaml> <out.yaml>
       rendertest stores <render.yaml> <observed-out.yaml>
       rendertest assert <api> <case> <empty|observed|stores> <render.yaml> [dashboard.json]");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((cmd, args)) = args.split_first() else { usage() };
    let result = match cmd.as_str() {
        "crds" => {
            let [input, out] = args else { usage() };
            filter_docs(input, out, |d| if s!(d, "kind") == "CustomResourceDefinition" { vec![d.clone()] } else { vec![] }, vec![])
        }
        "objects" => {
            let [input, out] = args else { usage() };
            let core = ["v1", "rbac.authorization.k8s.io/v1", "networking.k8s.io/v1", "apiregistration.k8s.io/v1", "batch/v1",
                "apps/v1", "policy/v1"];
            let manifests = RefCell::new(vec![]);
            
            filter_docs(input, out, |d| {
                if s!(d, "kind") == "Result" {
                    return vec![];
                }
                let mut out = vec![];
                if !core.contains(&s!(d, "apiVersion")) {
                    out.push(d.clone());
                }
                // Manifests come after all composed objects, as in the render output order.
                if let Some(m) = basis_tools::at!(d, "spec", "forProvider", "manifest").filter(|m| m.is_object())
                    && s!(d, "kind") == "Object"
                    && !core.contains(&s!(m, "apiVersion"))
                {
                    manifests.borrow_mut().push(m.clone());
                }
                out
            }, vec![Box::new(|| manifests.take())])
        }
        "stores" => {
            // The observed state in which every composed ObjectStore is
            // reported by its location: what a Cluster waits for (see
            // postgrescluster.rs).
            let [input, out] = args else { usage() };
            filter_docs(input, out, |d| {
                let m = v(basis_tools::at!(d, "spec", "forProvider", "manifest"));
                if s!(d, "kind") != "Object" || s!(m, "kind") != "ObjectStore" {
                    return vec![];
                }
                vec![json!({"apiVersion": s!(d, "apiVersion"), "kind": "Object", "metadata": d["metadata"],
                    "spec": d["spec"], "status": {"atProvider": {"manifest": m}}})]
            }, vec![])
        }
        "assert" => {
            if args.len() < 4 {
                usage();
            }
            std::process::exit(assert(&args[0], &args[1], &args[2], &args[3], &args[4..]));
        }
        _ => usage(),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

type Tail<'a> = Box<dyn FnOnce() -> Vec<Value> + 'a>;

/// Writes keep(d) for every document of input, then whatever the tails return.
fn filter_docs(input: &str, out: &str, keep: impl Fn(&Value) -> Vec<Value>, tail: Vec<Tail<'_>>) -> Result<(), String> {
    let docs = doc::load_all(input)?;
    let mut result: Vec<Value> = docs.iter().flat_map(&keep).collect();
    for t in tail {
        result.extend(t());
    }
    std::fs::write(out, yaml::encode_all(&result)).map_err(|e| format!("{out}: {e}"))
}

// --- assertions

static NULL: Value = Value::Null;

/// The value or null: absent reads like Go's nil.
pub fn v(o: Option<&Value>) -> &Value {
    o.unwrap_or(&NULL)
}

/// equal, absent as null.
pub fn eq(a: Option<&Value>, b: Value) -> bool {
    equal(v(a), &b)
}

/// repr of a value that may be absent.
pub fn repr(a: Option<&Value>) -> String {
    doc::repr(a)
}

/// One `crossplane render` output: the XR and its composed resources.
pub struct Render {
    pub kase: String,
    pub state: String,
    pub xr: Value,
    /// By composition-resource-name.
    pub composed: BTreeMap<String, Value>,
    pub status: Value,
    /// XR status conditions by type.
    pub conds: BTreeMap<String, Value>,
    pub name: String,
    pub ns: String,
    errors: RefCell<Vec<String>>,
}

impl Render {
    fn load(kase: &str, state: &str, path: &str, xr_kind: &str) -> Result<Render, String> {
        let docs = doc::load_all(path)?;
        let mut r = Render {
            kase: kase.into(),
            state: state.into(),
            xr: Value::Null,
            composed: BTreeMap::new(),
            status: Value::Null,
            conds: BTreeMap::new(),
            name: String::new(),
            ns: String::new(),
            errors: RefCell::default(),
        };
        for d in docs {
            match s!(&d, "kind") {
                k if k == xr_kind => r.xr = d,
                "Result" => {}
                _ => {
                    let key = s!(&d, "metadata", "annotations", "crossplane.io/composition-resource-name").to_string();
                    r.composed.insert(key, d);
                }
            }
        }
        if r.xr.is_null() {
            return Err(format!("{path}: no {xr_kind} in the render output"));
        }
        // The shape every assertion relies on; a real render always has it.
        if m!(&r.xr, "spec").is_none() || m!(&r.xr, "metadata").is_none() {
            return Err(format!("{path}: {xr_kind} without spec or metadata"));
        }
        for (key, d) in &r.composed {
            if s!(d, "kind").is_empty() || m!(d, "metadata").is_none() {
                return Err(format!("{path}: composed resource {key:?} without kind or metadata"));
            }
            if s!(d, "kind") == "Object" {
                let m = v(basis_tools::at!(d, "spec", "forProvider", "manifest"));
                if s!(m, "kind").is_empty() || m!(m, "metadata").is_none() {
                    return Err(format!("{path}: Object {key:?} without a manifest kind or metadata"));
                }
            }
        }
        r.status = m!(&r.xr, "status").map(|m| Value::Object(m.clone())).unwrap_or(Value::Null);
        for c in l!(&r.status, "conditions") {
            if s!(c, "type").is_empty() {
                r.check(false, format!("status condition without a type: {}", repr(Some(c))));
            }
            r.conds.insert(s!(c, "type").to_string(), c.clone());
        }
        r.name = s!(&r.xr, "metadata", "name").to_string();
        r.ns = s!(&r.xr, "metadata", "namespace").to_string();
        Ok(r)
    }

    pub fn check(&self, ok: bool, msg: impl Into<String>) {
        if !ok {
            self.errors.borrow_mut().push(msg.into());
        }
    }

    /// A composed resource; null when there's none.
    pub fn get(&self, key: &str) -> &Value {
        v(self.composed.get(key))
    }

    /// A condition of the XR; null when there's none.
    pub fn cond(&self, t: &str) -> &Value {
        v(self.conds.get(t))
    }

    /// The object a composed resource stands for: an Object's manifest, or itself.
    pub fn live(&self, key: &str) -> &Value {
        let obj = self.get(key);
        if s!(obj, "kind") == "Object" {
            return v(basis_tools::at!(obj, "spec", "forProvider", "manifest").filter(|m| m.is_object()));
        }
        obj
    }

    pub fn keys(&self) -> Vec<String> {
        self.composed.keys().cloned().collect()
    }

    /// Prints the result and returns the exit code.
    fn report(&self, fail_header: &str, ok_line: &str) -> i32 {
        let errors = self.errors.borrow();
        if !errors.is_empty() {
            println!("{fail_header}");
            for e in errors.iter() {
                println!("  - {e}");
            }
            return 1;
        }
        println!("{ok_line}");
        0
    }
}

fn assert(api: &str, kase: &str, state: &str, path: &str, rest: &[String]) -> i32 {
    let kind = match api {
        "postgrescluster" => "PostgresCluster",
        "project" => "Project",
        "location" => "Location",
        "genaistack" => "GenAIStack",
        "modelgateway" => "ModelGateway",
        "modelserver" => "ModelServer",
        "mcpserver" => "MCPServer",
        "valkeycache" => "ValkeyCache",
        _ => {
            eprintln!("no assertions for API {api:?}");
            return 2;
        }
    };
    if api == "postgrescluster" && rest.len() != 1 {
        usage();
    }
    let mut r = match Render::load(kase, state, path, kind) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let n = r.composed.len();
    let (fail, ok) = match api {
        "postgrescluster" => {
            postgrescluster::assert(&mut r, &rest[0]);
            (format!("FAIL {kase}/{state}:"), format!("OK {kase}/{state}: {n} composed resources"))
        }
        "project" => {
            project::assert(&r);
            (format!("FAIL project {kase}/{state}:"), format!("OK project {kase}/{state}: {n} composed resources"))
        }
        _ => {
            match api {
                "location" => location::assert(&r),
                "genaistack" => genaistack::assert(&r),
                "modelgateway" => modelgateway::assert(&r),
                "modelserver" => modelserver::assert(&r),
                "mcpserver" => mcpserver::assert(&r),
                _ => valkeycache::assert(&r),
            }
            (format!("FAIL {api}/{kase} ({state}):"), format!("ok   {api}/{kase} ({state})"))
        }
    };
    r.report(&fail, &ok)
}

// --- small helpers

pub type Set = BTreeSet<String>;

/// A string set.
pub fn set(items: &[&str]) -> Set {
    items.iter().map(|s| s.to_string()).collect()
}

/// The sets merged.
pub fn union(sets: &[&Set]) -> Set {
    sets.iter().flat_map(|s| s.iter().cloned()).collect()
}

/// {prefix+k} for every k in s.
pub fn prefixed(prefix: &str, s: &Set) -> Set {
    s.iter().map(|k| format!("{prefix}{k}")).collect()
}

/// A map's keys are exactly want.
pub fn same_keys<V>(m: &BTreeMap<String, V>, want: &Set) -> bool {
    m.len() == want.len() && m.keys().all(|k| want.contains(k))
}

/// A JSON object's keys are exactly want.
pub fn same_obj_keys(m: Option<&serde_json::Map<String, Value>>, want: &Set) -> bool {
    let n = m.map_or(0, |m| m.len());
    n == want.len() && m.into_iter().flat_map(|m| m.keys()).all(|k| want.contains(k))
}

/// A set, as Go prints a []string.
pub fn list_str<'a>(items: impl IntoIterator<Item = &'a String>) -> String {
    format!("[{}]", items.into_iter().map(String::as_str).collect::<Vec<_>>().join(" "))
}

/// Every key and string value under v, for text searches.
pub fn all_strings(v: &Value) -> String {
    doc::all_strings(v)
}

/// Standard base64, decoded to text.
pub fn unb64(s: &str) -> Option<String> {
    function_basis::common::util::unb64(s)
}

/// Standard base64 the way Go's DecodeString reads it when its error is
/// ignored: what decoded before the first bad group.
pub fn unb64_lenient(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    for chunk in b.chunks(4) {
        match std::str::from_utf8(chunk).ok().filter(|_| chunk.len() == 4).and_then(unb64) {
            Some(text) => out.push_str(&text),
            None => break,
        }
    }
    out
}
