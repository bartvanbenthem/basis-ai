//! alertrules writes src/alerts/cnpg-cluster-rules.yaml from the
//! PrometheusRule the upstream cnpg/cluster Helm chart renders; see
//! hack/refresh-alerts.sh.
//!
//!     alertrules <prometheus-rule.yaml> <out.yaml> <chart-version>

use basis_tools::doc::Key;
use basis_tools::yaml::{self, Node, Style};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        eprintln!("usage: alertrules <prometheus-rule.yaml> <out.yaml> <chart-version>");
        std::process::exit(2);
    }
    if let Err(e) = run(&args[0], &args[1], &args[2]) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run(src: &str, out: &str, version: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(src).map_err(|e| format!("{src}: {e}"))?;
    let mut docs = yaml::parse_nodes(&raw).map_err(|e| format!("{src}: {e}"))?;
    let doc = docs.first_mut().ok_or_else(|| format!("{src}: no spec.groups[0].rules"))?;
    let Some(Node::Seq(rules)) = doc.lookup_mut(&[Key::S("spec"), Key::S("groups"), Key::I(0), Key::S("rules")]) else {
        return Err(format!("{src}: no spec.groups[0].rules"));
    };
    for rule in rules.iter_mut() {
        // Helm-specific labels that would only confuse alert routing.
        if let Some(Node::Map(labels)) = rule.lookup_mut(&[Key::S("labels")]) {
            labels.retain(|(k, _)| {
                let k = k.text().unwrap_or("");
                !k.starts_with("app.kubernetes.io/") && !k.starts_with("helm.sh/")
            });
        }
    }
    let n = rules.len();
    let mut rules = Node::Seq(std::mem::take(rules));
    literal_blocks(&mut rules);
    let body = yaml::encode_node(&rules);
    let header = format!("# CloudNativePG alert rules, rendered from the upstream cnpg/cluster Helm
# chart {version} (Apache-2.0, https://github.com/cloudnative-pg/charts) by
# hack/refresh-alerts.sh -- do not edit by hand; change a rule by adding its
# replacement to local-rules.yaml. function-basis substitutes, per cluster:
#   zzclusterzz   -> the PostgresCluster name
#   zznamespacezz -> the PostgresCluster namespace
");
    std::fs::write(out, header + &body).map_err(|e| format!("{out}: {e}"))?;
    println!("wrote {n} rules from cnpg/cluster {version} to {out}");
    Ok(())
}

/// Multi-line strings (alert descriptions, PromQL) as readable `|` blocks
/// instead of folded quoted scalars.
fn literal_blocks(n: &mut Node) {
    if n.is_str()
        && let Node::Scalar(s, style) = n
        && s.contains('\n')
    {
        *style = Style::Literal;
    }
    match n {
        Node::Map(m) => m.iter_mut().for_each(|(k, v)| {
            literal_blocks(k);
            literal_blocks(v);
        }),
        Node::Seq(l) => l.iter_mut().for_each(literal_blocks),
        Node::Scalar(..) => {}
    }
}
