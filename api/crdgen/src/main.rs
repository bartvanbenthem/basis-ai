//! crdgen generates crds/ (the basis-crds crate) with kopium: a module per
//! kind in KINDS, from its CRD in tests/crds or the vendored CNPG charts,
//! without what ELIDE leaves out. Adding a kind and upgrading an operator:
//! api/README.md, "Operator types".
//!
//!     make crds   # cargo run -p basis-crdgen: write crds/src
//!     make check  # ... -- --check: exit 1 if a file is stale
//!
//! kopium's output differs between versions, so it must be KOPIUM_VERSION.
//! A package of its own: it must never need basis-crds (which it writes) to build.

use serde::Deserialize as _;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const KOPIUM_VERSION: &str = "0.24.1";

const CNPG_CRDS: &str = "../deps/cnpg/charts/cloudnative-pg/templates/crds/crds.yaml";
const BARMAN_CRDS: &str = "../deps/cnpg/charts/plugin-barman-cloud/templates/crds/crds.yaml";

/// (group module, kind module, CRD file relative to api/, CRD name, version).
/// kopium types a kind's spec and status: a kind without (a COSI
/// BucketClass) has nothing to generate and stays JSON.
const KINDS: &[(&str, &str, &str, &str, &str)] = &[
    ("aigateway", "ai_gateway_route", "tests/crds/aigatewayroutes.aigateway.envoyproxy.io.yaml", "aigatewayroutes.aigateway.envoyproxy.io", "v1beta1"),
    ("aigateway", "ai_service_backend", "tests/crds/aiservicebackends.aigateway.envoyproxy.io.yaml", "aiservicebackends.aigateway.envoyproxy.io", "v1beta1"),
    ("aigateway", "backend_security_policy", "tests/crds/backendsecuritypolicies.aigateway.envoyproxy.io.yaml", "backendsecuritypolicies.aigateway.envoyproxy.io", "v1beta1"),
    ("barman", "object_store", BARMAN_CRDS, "objectstores.barmancloud.cnpg.io", "v1"),
    ("cert_manager", "certificate", "tests/crds/certificates.cert-manager.io.yaml", "certificates.cert-manager.io", "v1"),
    ("cnpg", "cluster", CNPG_CRDS, "clusters.postgresql.cnpg.io", "v1"),
    ("cnpg", "database", CNPG_CRDS, "databases.postgresql.cnpg.io", "v1"),
    ("cnpg", "pooler", CNPG_CRDS, "poolers.postgresql.cnpg.io", "v1"),
    ("cnpg", "scheduled_backup", CNPG_CRDS, "scheduledbackups.postgresql.cnpg.io", "v1"),
    ("cosi", "bucket_access", "tests/crds/objectstorage.k8s.io_bucketaccesses.yaml", "bucketaccesses.objectstorage.k8s.io", "v1alpha1"),
    ("cosi", "bucket_claim", "tests/crds/objectstorage.k8s.io_bucketclaims.yaml", "bucketclaims.objectstorage.k8s.io", "v1alpha1"),
    ("crossplane", "cluster_usage", "tests/crds/protection.crossplane.io_clusterusages.yaml", "clusterusages.protection.crossplane.io", "v1beta1"),
    ("envoy_gateway", "backend", "tests/crds/backends.gateway.envoyproxy.io.yaml", "backends.gateway.envoyproxy.io", "v1alpha1"),
    ("envoy_gateway", "backend_traffic_policy", "tests/crds/backendtrafficpolicies.gateway.envoyproxy.io.yaml", "backendtrafficpolicies.gateway.envoyproxy.io", "v1alpha1"),
    ("envoy_gateway", "client_traffic_policy", "tests/crds/clienttrafficpolicies.gateway.envoyproxy.io.yaml", "clienttrafficpolicies.gateway.envoyproxy.io", "v1alpha1"),
    ("envoy_gateway", "envoy_proxy", "tests/crds/envoyproxies.gateway.envoyproxy.io.yaml", "envoyproxies.gateway.envoyproxy.io", "v1alpha1"),
    ("envoy_gateway", "security_policy", "tests/crds/securitypolicies.gateway.envoyproxy.io.yaml", "securitypolicies.gateway.envoyproxy.io", "v1alpha1"),
    ("gateway_api", "backend_tls_policy", "tests/crds/backendtlspolicies.gateway.networking.k8s.io.yaml", "backendtlspolicies.gateway.networking.k8s.io", "v1"),
    ("gateway_api", "gateway", "tests/crds/gateways.gateway.networking.k8s.io.yaml", "gateways.gateway.networking.k8s.io", "v1"),
    ("grafana", "grafana", "tests/crds/grafana.integreatly.org_grafanas.yaml", "grafanas.grafana.integreatly.org", "v1beta1"),
    ("grafana", "grafana_dashboard", "tests/crds/grafana.integreatly.org_grafanadashboards.yaml", "grafanadashboards.grafana.integreatly.org", "v1beta1"),
    ("grafana", "grafana_datasource", "tests/crds/grafana.integreatly.org_grafanadatasources.yaml", "grafanadatasources.grafana.integreatly.org", "v1beta1"),
    ("kserve", "llm_inference_service", "tests/crds/serving.kserve.io_llminferenceservices.yaml", "llminferenceservices.serving.kserve.io", "v1alpha2"),
    ("prometheus", "pod_monitor", "tests/crds/monitoring.coreos.com_podmonitors.yaml", "podmonitors.monitoring.coreos.com", "v1"),
    ("prometheus", "prometheus", "tests/crds/monitoring.coreos.com_prometheuses.yaml", "prometheuses.monitoring.coreos.com", "v1"),
    ("prometheus", "prometheus_rule", "tests/crds/monitoring.coreos.com_prometheusrules.yaml", "prometheusrules.monitoring.coreos.com", "v1"),
    ("provider_kubernetes", "cluster_provider_config", "tests/crds/kubernetes.m.crossplane.io_clusterproviderconfigs.yaml", "clusterproviderconfigs.kubernetes.m.crossplane.io", "v1alpha1"),
    ("provider_kubernetes", "object", "tests/crds/kubernetes.m.crossplane.io_objects.yaml", "objects.kubernetes.m.crossplane.io", "v1alpha1"),
    ("valkey", "valkey_cluster", "tests/crds/valkey.io_valkeyclusters.yaml", "valkeyclusters.valkey.io", "v1alpha1"),
];

/// What an elided type becomes.
const VALUE: &str = "serde_json::Value";
const POD_SPEC: &str = "k8s_openapi::api::core::v1::PodSpec";

/// Types of a kind to leave out, with every type only they use:
/// (kind module, kopium's type name, what it becomes). kopium writes out
/// every embedded pod spec, container and auth provider as types of their
/// own, thousands of lines a kind, and a build of basis-crds with all of them
/// takes over 6 GB. A subtree no composition writes becomes plain JSON; a
/// pod spec the compositions write becomes k8s-openapi's. A name kopium no
/// longer generates fails `make crds`.
const ELIDE: &[(&str, &str, &str)] = &[
    ("backend_security_policy", "BackendSecurityPolicyAwsCredentials", VALUE),
    ("backend_security_policy", "BackendSecurityPolicyAzureCredentials", VALUE),
    ("backend_security_policy", "BackendSecurityPolicyGcpCredentials", VALUE),
    ("envoy_proxy", "EnvoyProxyProviderKubernetesEnvoyDaemonSet", VALUE),
    ("envoy_proxy", "EnvoyProxyProviderKubernetesEnvoyDeploymentContainer", VALUE),
    ("envoy_proxy", "EnvoyProxyProviderKubernetesEnvoyDeploymentInitContainers", VALUE),
    ("envoy_proxy", "EnvoyProxyProviderKubernetesEnvoyDeploymentPod", VALUE),
    ("envoy_proxy", "EnvoyProxyProviderKubernetesEnvoyHpa", VALUE),
    ("envoy_proxy", "EnvoyProxyTelemetryMetrics", VALUE),
    ("envoy_proxy", "EnvoyProxyTelemetryTracing", VALUE),
    ("grafana", "GrafanaDeployment", VALUE),
    ("grafana", "GrafanaHttpRoute", VALUE),
    ("llm_inference_service", "LlmInferenceServicePrefill", VALUE),
    ("llm_inference_service", "LlmInferenceServiceRouter", VALUE),
    ("llm_inference_service", "LlmInferenceServiceTemplate", POD_SPEC),
    ("llm_inference_service", "LlmInferenceServiceWorker", POD_SPEC),
    ("pooler", "PoolerTemplateSpecContainers", VALUE),
    ("pooler", "PoolerTemplateSpecEphemeralContainers", VALUE),
    ("pooler", "PoolerTemplateSpecInitContainers", VALUE),
    ("pooler", "PoolerTemplateSpecVolumes", VALUE),
    ("prometheus", "PrometheusAlerting", VALUE),
    ("prometheus", "PrometheusApiserverConfig", VALUE),
    ("prometheus", "PrometheusContainers", VALUE),
    ("prometheus", "PrometheusInitContainers", VALUE),
    ("prometheus", "PrometheusRemoteRead", VALUE),
    ("prometheus", "PrometheusScrapeClasses", VALUE),
    ("prometheus", "PrometheusThanos", VALUE),
    ("prometheus", "PrometheusVolumes", VALUE),
    ("security_policy", "SecurityPolicyExtAuth", VALUE),
    ("security_policy", "SecurityPolicyJwt", VALUE),
    ("security_policy", "SecurityPolicyOidc", VALUE),
];

/// What each group module is, for its mod.rs.
const GROUPS: &[(&str, &str)] = &[
    ("aigateway", "aigateway.envoyproxy.io: Agent Router (formerly Envoy AI Gateway)"),
    ("barman", "barmancloud.cnpg.io: the Barman Cloud plugin of CloudNativePG"),
    ("cert_manager", "cert-manager.io"),
    ("cnpg", "postgresql.cnpg.io: CloudNativePG"),
    ("cosi", "objectstorage.k8s.io: COSI buckets"),
    ("crossplane", "protection.crossplane.io: Crossplane"),
    ("envoy_gateway", "gateway.envoyproxy.io: Envoy Gateway"),
    ("gateway_api", "gateway.networking.k8s.io: Gateway API"),
    ("grafana", "grafana.integreatly.org: grafana-operator"),
    ("kserve", "serving.kserve.io: KServe"),
    ("prometheus", "monitoring.coreos.com: Prometheus Operator"),
    ("provider_kubernetes", "kubernetes.m.crossplane.io: provider-kubernetes"),
    ("valkey", "valkey.io: the valkey-io operator"),
];

const HEADER: &str = "// GENERATED by `make crds` (api/crdgen) -- DO NOT EDIT.\n";

fn main() {
    let check = std::env::args().skip(1).any(|a| a == "--check" || a == "-check");
    if let Err(e) = run(check) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn run(check: bool) -> Result<(), String> {
    kopium_version()?;
    let base = root();
    let src = base.join("crds").join("src");
    let scratch = std::env::temp_dir().join(format!("basis-crds-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).map_err(|e| format!("{}: {e}", scratch.display()))?;
    let result = outputs(&base, &src, &scratch);
    let _ = std::fs::remove_dir_all(&scratch);
    let outputs = result?;

    let mut stale = vec![];
    for (path, content) in &outputs {
        let rel = path.strip_prefix(&base).unwrap_or(path).display().to_string();
        if check {
            match std::fs::read_to_string(path) {
                Ok(current) if &current == content => {}
                _ => stale.push(rel),
            }
            continue;
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::write(path, content).map_err(|e| format!("{rel}: {e}"))?;
        println!("wrote {rel} ({} KiB)", content.len() / 1024);
    }
    // A kind or group taken out of KINDS leaves its file behind.
    let wanted: Vec<&PathBuf> = outputs.iter().map(|(p, _)| p).collect();
    for path in rust_files(&src) {
        if !wanted.contains(&&path) {
            let rel = path.strip_prefix(&base).unwrap_or(&path).display().to_string();
            if check {
                stale.push(format!("{rel} (not in KINDS)"));
            } else {
                std::fs::remove_file(&path).map_err(|e| format!("{rel}: {e}"))?;
                println!("removed {rel}");
            }
        }
    }
    if !stale.is_empty() {
        return Err(format!("stale: run `make crds`\n  {}", stale.join("\n  ")));
    }
    if check {
        println!("crds/src is up to date ({} kinds)", KINDS.len());
    }
    Ok(())
}

fn kopium_version() -> Result<(), String> {
    let out = Command::new("kopium").arg("--version").output().map_err(|e| {
        format!("kopium: {e}\ninstall it: cargo install kopium --version {KOPIUM_VERSION} --locked")
    })?;
    let version = String::from_utf8_lossy(&out.stdout);
    let version = version.trim().trim_start_matches("kopium ").to_string();
    if version != KOPIUM_VERSION {
        return Err(format!(
            "kopium {version}, but crds/ is generated with {KOPIUM_VERSION}: \
             cargo install kopium --version {KOPIUM_VERSION} --locked \
             (or raise KOPIUM_VERSION in crdgen/src/main.rs and run `make crds`)"
        ));
    }
    Ok(())
}

/// Every file of crds/src, as it should be.
fn outputs(base: &Path, src: &Path, scratch: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let mut files = vec![];
    let mut groups: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut sources: BTreeMap<&str, Vec<serde_yaml::Value>> = BTreeMap::new();
    for &(group, kind, file, name, version) in KINDS {
        if !sources.contains_key(file) {
            sources.insert(file, crd_documents(&base.join(file))?);
        }
        let crd = sources[file]
            .iter()
            .find(|d| d["metadata"]["name"].as_str() == Some(name))
            .ok_or_else(|| format!("{file}: no CustomResourceDefinition {name}"))?;
        let input = scratch.join(format!("{name}.yaml"));
        let yaml = serde_yaml::to_string(crd).map_err(|e| format!("{name}: {e}"))?;
        std::fs::write(&input, yaml).map_err(|e| format!("{}: {e}", input.display()))?;
        let code = kopium(&input, version).map_err(|e| format!("{name} {version}: {e}"))?;
        // kopium's own header names the scratch file; say where it came from instead.
        let body: String = code.lines().skip_while(|l| l.starts_with("//")).map(|l| format!("{l}\n")).collect();
        let elide: Vec<(&str, &str)> = ELIDE.iter().filter(|e| e.0 == kind).map(|e| (e.1, e.2)).collect();
        let body = elided(&body, &elide).map_err(|e| format!("{name}: {e}"))?;
        let content = format!("{HEADER}// kopium {KOPIUM_VERSION} from {file}: {name} {version}\n\n{}", body.trim_start_matches('\n'));
        files.push((src.join(group).join(format!("{kind}.rs")), content));
        groups.entry(group).or_default().push(kind);
    }

    let mut lib = format!(
        "{HEADER}//! Rust types for the operator kinds the compositions write, generated by\n\
         //! kopium from their CRDs. One module per API group, one per kind in it;\n\
         //! see crdgen/src/main.rs for where each comes from.\n\n"
    );
    for (group, kinds) in &groups {
        let doc = GROUPS.iter().find(|(g, _)| g == group).map(|(_, d)| *d).ok_or_else(|| format!("{group}: not in GROUPS"))?;
        lib.push_str(&format!("pub mod {group};\n"));
        let mut m = format!("{HEADER}//! {doc}\n\n");
        for kind in kinds {
            // The generated code is kopium's: lints are not ours to fix.
            m.push_str(&format!("#[allow(clippy::all, clippy::pedantic, non_camel_case_types, non_snake_case, unused_imports)]\npub mod {kind};\n"));
        }
        files.push((src.join(group).join("mod.rs"), m));
    }
    files.push((src.join("lib.rs"), lib));
    Ok(files)
}

/// kopium's output without the elided types and the types only they use,
/// each elided type an alias of its replacement. kopium writes one block per
/// type (its attributes, then `pub struct|enum Name {` ... `}`), blocks
/// separated by a blank line.
fn elided(code: &str, elide: &[(&str, &str)]) -> Result<String, String> {
    if elide.is_empty() {
        return Ok(code.to_string());
    }
    let blocks: Vec<&str> = code.split("\n\n").collect();
    let type_name = |block: &str| {
        block.lines().find_map(|l| {
            let rest = l.strip_prefix("pub struct ").or_else(|| l.strip_prefix("pub enum "))?;
            Some(rest.split(|c: char| !c.is_alphanumeric() && c != '_').next()?.to_string())
        })
    };
    let types: BTreeMap<String, usize> = blocks.iter().enumerate().filter_map(|(i, b)| type_name(b).map(|n| (n, i))).collect();
    for (name, _) in elide {
        if !types.contains_key(*name) {
            return Err(format!("ELIDE: kopium generates no type {name}"));
        }
    }
    let uses = |block: &str| -> Vec<String> {
        block.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|w| types.contains_key(*w)).map(String::from).collect()
    };
    // What the kind uses, from the types no other type uses (its spec and
    // status), never going into an elided one.
    let used_by_others: std::collections::BTreeSet<String> =
        types.iter().flat_map(|(n, &i)| uses(blocks[i]).into_iter().filter(move |u| u != n)).collect();
    let mut keep: std::collections::BTreeSet<String> = types.keys().filter(|n| !used_by_others.contains(*n)).cloned().collect();
    let mut todo: Vec<String> = keep.iter().cloned().collect();
    while let Some(n) = todo.pop() {
        for u in uses(blocks[types[&n]]) {
            if !elide.iter().any(|(e, _)| *e == u) && keep.insert(u.clone()) {
                todo.push(u);
            }
        }
    }
    let mut out: Vec<String> = blocks
        .iter()
        .filter(|b| !b.trim().is_empty() && type_name(b).is_none_or(|n| keep.contains(&n)))
        .map(|b| b.trim_matches('\n').to_string())
        .collect();
    let aliases: Vec<String> = elide.iter().map(|(name, to)| format!("pub type {name} = {to};")).collect();
    out.push(format!("// Elided (ELIDE in crdgen/src/main.rs).\n{}", aliases.join("\n")));
    Ok(out.join("\n\n") + "\n")
}

/// The api directory.
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("the api directory").to_path_buf()
}

/// The CustomResourceDefinitions in a file, a chart's {{ if }} wrapper dropped.
fn crd_documents(path: &Path) -> Result<Vec<serde_yaml::Value>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text: String = raw.lines().filter(|l| !l.trim_start().starts_with("{{")).map(|l| format!("{l}\n")).collect();
    let mut docs = vec![];
    for d in serde_yaml::Deserializer::from_str(&text) {
        let v = serde_yaml::Value::deserialize(d).map_err(|e| format!("{}: {e}", path.display()))?;
        if v["kind"].as_str() == Some("CustomResourceDefinition") {
            docs.push(v);
        }
    }
    Ok(docs)
}

fn kopium(input: &Path, version: &str) -> Result<String, String> {
    let out = Command::new("kopium")
        .arg("-f")
        .arg(input)
        .args(["--api-version", version, "--derive", "Default", "--smart-derive-elision"])
        .output()
        .map_err(|e| format!("kopium: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    String::from_utf8(out.stdout).map_err(|e| format!("kopium output: {e}"))
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(rust_files(&p));
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
    out
}
