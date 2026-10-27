//! What a Project runs on the control plane and in each of its locations.

use k8s_openapi::api::batch::v1::{CronJob, CronJobSpec, JobSpec, JobTemplateSpec};
use k8s_openapi::api::core::v1::{
    Capabilities, Container, EmptyDirVolumeSource, EnvVar, EnvVarSource, LimitRange, LimitRangeItem, LimitRangeSpec, Namespace,
    PersistentVolumeClaim, PersistentVolumeClaimSpec, PodSecurityContext, PodSpec, PodTemplateSpec, ResourceQuota, ResourceQuotaSpec,
    ResourceRequirements, SeccompProfile, Secret, SecretKeySelector, SecurityContext, ServiceAccount, Volume, VolumeMount,
    VolumeResourceRequirements,
};
use k8s_openapi::api::networking::v1::{
    HTTPIngressPath, HTTPIngressRuleValue, Ingress, IngressBackend, IngressRule, IngressServiceBackend, IngressSpec, IngressTLS,
    ServiceBackendPort,
};
use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleBinding, RoleRef, Subject};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, LabelSelectorRequirement, ObjectMeta};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use super::{BackupCheck, Member, MemberStatus, Settings, empty};
use crate::common::gojson::sprint;
use crate::common::kinds::crds::grafana::{grafana as g, grafana_datasource as gds};
use crate::common::kinds::crds::prometheus::prometheus as p;
use crate::common::kinds::{Labels, location_object, map_opt, meta, quantities, retype, secret_copy, str_opt, to_value};
use crate::common::util::{as_obj, as_str, bool_or, condition_true, dig, or, sha1hex, trunc};
use crate::common::Composed;

/// One of a member's objects, by composition resource name.
pub(super) struct Obj {
    pub key: String,
    pub manifest: Value,
    pub ready: bool,
    /// In a location: never deleted by Crossplane.
    pub orphan: bool,
    /// In a location: a Secret whose data comes from <ns>/<name> on the control plane.
    pub copy_from: String,
}

impl Obj {
    fn new(key: &str, ready: bool, manifest: Value) -> Obj {
        Obj { key: key.into(), manifest, ready, orphan: false, copy_from: String::new() }
    }
}

/// backupCheckScript writes, reads back and deletes platform-check/<location>
/// in the bucket: what WAL archiving (write) and a replica cluster (read)
/// need. The job's log says why it failed.
const BACKUP_CHECK_SCRIPT: &str = r#"set -u
key="platform-check/${LOCATION}"
url="${S3_ENDPOINT%/}/${S3_BUCKET}/${key}"
s3() {
  method=$1; shift
  code=$(curl -sS -o /tmp/body -w '%{http_code}' --connect-timeout 10 --max-time 30 \
    --aws-sigv4 "aws:amz:${REGION:-us-east-1}:s3" --user "${ACCESS_KEY_ID}:${ACCESS_SECRET_KEY}" \
    -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' -X "$method" "$@" "$url" 2>/tmp/err) \
    || { echo "$method $url: $(cat /tmp/err)"; return 1; }
  case $code in 2??) return 0 ;; esac
  echo "$method $url: HTTP $code $(sed -n 's:.*<Code>\(.*\)</Code>.*:\1:p' /tmp/body)"
  return 1
}
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
s3 PUT --data-binary "$stamp" || exit 1
s3 GET || exit 1
[ "$(cat /tmp/body)" = "$stamp" ] || { echo "GET $url: read back something else than was written"; exit 1; }
s3 DELETE || echo "warning: could not delete the test object"
echo "ok: wrote, read back and deleted s3://${S3_BUCKET}/${key} via ${S3_ENDPOINT}"
"#;

const RBAC: &str = "rbac.authorization.k8s.io";

impl Settings {
    /// The namespace and what's in it for the control plane or one location,
    /// and what it waits for.
    pub(super) fn member(&self, m: &Member, unschedulable: &[String], check: Option<&BackupCheck>) -> (Vec<Obj>, MemberStatus) {
        let local = m.local();
        let observed = &m.observed;
        let env = Value::Object(self.env.clone());
        let spec = self.spec_v();
        let cluster_metrics = as_obj(dig(&env, &["prometheus", "clusterMetrics"]));
        let cm_enabled = bool_or(cluster_metrics.get("enabled"), true);
        let cm_namespace = or(as_str(cluster_metrics.get("namespace")), "prometheus-operator-system").to_string();
        let cm_labels = match cluster_metrics.get("serviceMonitorLabels") {
            Some(Value::Object(l)) => l.clone(),
            _ => json!({"release": "prometheus-operator"}).as_object().cloned().unwrap_or_default(),
        };
        let cm_exclude = match cluster_metrics.get("excludeApps") {
            Some(Value::Array(l)) => l.clone(),
            _ => [
                "kube-prometheus-stack-apiserver", "kube-prometheus-stack-coredns", "kube-prometheus-stack-kube-controller-manager",
                "kube-prometheus-stack-kube-etcd", "kube-prometheus-stack-kube-proxy", "kube-prometheus-stack-kube-scheduler",
                "kube-prometheus-stack-operator",
            ].iter().map(|s| json!(s)).collect(),
        };
        let operator_metrics = as_obj(dig(&env, &["prometheus", "operatorMetrics"]));
        let om_enabled = bool_or(operator_metrics.get("enabled"), true);
        let om_namespace = or(as_str(operator_metrics.get("namespace")), "cnpg-system").to_string();

        let obs = as_obj(self.spec.get("observability"));
        let prom = as_obj(obs.get("prometheus"));
        let prom_enabled = bool_or(prom.get("enabled"), true);
        let graf = as_obj(obs.get("grafana"));
        let graf_enabled = local && bool_or(graf.get("enabled"), true);
        let mut host = String::new();
        let tpl = as_str(self.ingress.get("hostTemplate"));
        if graf_enabled && bool_or(graf.get("ingress"), true) && !tpl.is_empty() {
            host = tpl.replace("{project}", &self.name);
        }
        let quota = as_obj(self.spec.get("quota"));
        let scope = Labels::from([("dashboards.paas.cndev.nl/scope".to_string(), self.ns.clone())]);

        let ns_obs = observed.get("namespace");
        let ns_ready = ns_obs.is_some_and(|n| as_str(dig(n, &["status", "phase"])) == "Active");
        let prom_ready = observed.get("prometheus").is_some_and(|p| condition_true(Some(p), "Available"));
        let graf_ready = observed.get("grafana").is_some_and(|g| {
            as_str(dig(g, &["status", "stage"])) == "complete" && as_str(dig(g, &["status", "stageStatus"])) == "success"
        });
        let seen = |key: &str| observed.contains_key(key);

        let mut objects: Vec<Obj> = vec![];

        // ---- the namespace
        let mut ns_ann = Labels::new();
        let d = as_str(self.spec.get("description"));
        if !d.is_empty() {
            ns_ann.insert("platform.cndev.nl/description".into(), d.into());
        }
        if local {
            // Read by the admission policies and the workload compositions.
            let l = as_str(dig(&spec, &["locations", "protected"]));
            if !l.is_empty() {
                ns_ann.insert("platform.cndev.nl/protected-location".into(), l.into());
            }
            let l = as_str(dig(&spec, &["locations", "recovery"]));
            if !l.is_empty() {
                ns_ann.insert("platform.cndev.nl/recovery-location".into(), l.into());
            }
            if self.bucket_on {
                // PostgresClusters may then leave backup.destinationPath out.
                ns_ann.insert("platform.cndev.nl/backup-bucket".into(), "true".into());
            }
            if !unschedulable.is_empty() {
                // Locations whose Location says schedulable: false; the same
                // policies refuse workloads that newly add them.
                ns_ann.insert("platform.cndev.nl/unschedulable-locations".into(), unschedulable.join(","));
            }
        }
        let mut ns_labels = self.labels();
        ns_labels.extend(scope.clone());
        let o = as_str(self.spec.get("owner"));
        if !o.is_empty() {
            ns_labels.insert("backstage.io/owner".into(), o.into());
        }
        ns_labels.extend(self.gov.labels());
        // CNPG, Prometheus and Grafana all run under "baseline"; "restricted"
        // warnings flag workloads to harden.
        ns_labels.insert("pod-security.kubernetes.io/enforce".into(), "baseline".into());
        ns_labels.insert("pod-security.kubernetes.io/warn".into(), "restricted".into());
        let namespace = Namespace {
            metadata: ObjectMeta { annotations: map_opt(ns_ann), ..meta(&self.ns, "", &ns_labels) },
            ..Default::default()
        };
        let mut ns = Obj::new("namespace", ns_ready, to_value(&namespace));
        ns.orphan = !local;
        objects.push(ns);

        if prom_enabled && !local {
            // Cluster-wide: kubelet/cAdvisor targets live on the nodes and
            // kube-state-metrics/node-exporter in the kube-prometheus-stack
            // namespace. One shared ClusterRole, one binding per project. (Named
            // basis:..., not platform:..., since its roleRef moved from
            // cnpg-platform:project-prometheus: a roleRef can't change in place.)
            objects.push(Obj::new("prometheus-clusterrolebinding", seen("prometheus-clusterrolebinding"), to_value(&ClusterRoleBinding {
                metadata: meta(&format!("basis:project:{}:prometheus", self.name), "", &self.labels()),
                role_ref: RoleRef { api_group: Some(RBAC.into()), kind: "ClusterRole".into(), name: "basis:project-prometheus".into() },
                subjects: Some(vec![Subject {
                    kind: "ServiceAccount".into(), name: "prometheus".into(), namespace: Some(self.ns.clone()), ..Default::default()
                }]),
            })));
        }

        if ns_obs.is_some() {
            if prom_enabled {
                objects.push(Obj::new("prometheus-serviceaccount", seen("prometheus-serviceaccount"),
                    to_value(&ServiceAccount { metadata: self.meta("prometheus"), ..Default::default() })));
                objects.push(Obj::new("prometheus", prom_ready, to_value(&p::Prometheus {
                    metadata: self.meta("prometheus"),
                    spec: self.prometheus_spec(m, &prom, cm_enabled, &cm_namespace, &cm_labels, &cm_exclude, om_enabled, &om_namespace),
                    status: None,
                })));
                // The Prometheus StatefulSet's volume, composed so that growing
                // spec.observability.prometheus.storage.size grows the PVC: a
                // StatefulSet never resizes its volumeClaimTemplate's PVCs. Named
                // as the StatefulSet would name it. Bound only once the pod is
                // scheduled (WaitForFirstConsumer); the Prometheus' readiness
                // already covers that.
                objects.push(Obj::new("prometheus-pvc", true, to_value(&PersistentVolumeClaim {
                    metadata: self.meta("prometheus-prometheus-db-prometheus-prometheus-0"),
                    spec: Some(pvc_spec(&prom)),
                    status: None,
                })));
                // The project's cost, from what its locations write here.
                if local && self.gov.prices.is_some() {
                    objects.push(Obj::new("cost-rules", seen("cost-rules"), self.gov.cost_rules(self)));
                    if graf_enabled {
                        objects.push(Obj::new("cost-dashboard", seen("cost-dashboard"), self.gov.cost_dashboard(self)));
                    }
                }
            }

            if graf_enabled {
                objects.push(Obj::new("grafana", graf_ready, self.grafana(&host, &scope)));
                if prom_enabled {
                    // Named "prometheus": the datasource name the workloads'
                    // dashboards are wired to.
                    objects.push(Obj::new("grafana-datasource", seen("grafana-datasource"), to_value(&gds::GrafanaDatasource {
                        metadata: self.meta("prometheus"),
                        spec: gds::GrafanaDatasourceSpec {
                            instance_selector: gds::GrafanaDatasourceInstanceSelector { match_labels: Some(scope.clone()), ..Default::default() },
                            datasource: gds::GrafanaDatasourceDatasource {
                                name: Some("prometheus".into()), r#type: Some("prometheus".into()), access: Some("proxy".into()),
                                url: Some(format!("http://prometheus-operated.{}.svc:9090", self.ns)), is_default: Some(true),
                                ..Default::default()
                            },
                            ..Default::default()
                        },
                        status: None,
                    })));
                }
            }

            if local && prom_enabled && !self.rw_host.is_empty() {
                objects.push(Obj::new("prometheus-remote-write", seen("prometheus-remote-write"), self.remote_write_ingress()));
            }

            if let Some(access) = self.spec.get("access").and_then(Value::as_array) {
                for (i, a) in access.iter().enumerate() {
                    let a = as_obj(Some(a));
                    let key = format!("access-{i}");
                    let group = as_str(a.get("group"));
                    let role = as_str(a.get("role"));
                    objects.push(Obj::new(&key, seen(&key), to_value(&RoleBinding {
                        metadata: ObjectMeta {
                            annotations: Some(Labels::from([("platform.cndev.nl/group".to_string(), group.to_string())])),
                            ..self.meta(&format!("project-{role}-{}", trunc(&sha1hex(group), 8)))
                        },
                        role_ref: RoleRef { api_group: Some(RBAC.into()), kind: "ClusterRole".into(), name: role.into() },
                        subjects: Some(vec![Subject { api_group: Some(RBAC.into()), kind: "Group".into(), name: group.into(), namespace: None }]),
                    })));
                }
            }

            // The quota is for the workloads: none on the control plane.
            if !quota.is_empty() && !local {
                let mut hard = BTreeMap::new();
                let v = as_str(quota.get("cpu"));
                if !v.is_empty() {
                    hard.insert("requests.cpu".to_string(), Quantity(v.into()));
                }
                let v = as_str(quota.get("memory"));
                if !v.is_empty() {
                    hard.insert("requests.memory".to_string(), Quantity(v.into()));
                    hard.insert("limits.memory".to_string(), Quantity(v.into()));
                }
                let v = as_str(quota.get("storage"));
                if !v.is_empty() {
                    hard.insert("requests.storage".to_string(), Quantity(v.into()));
                }
                objects.push(Obj::new("quota", seen("quota"), to_value(&ResourceQuota {
                    metadata: self.meta("project"),
                    spec: Some(ResourceQuotaSpec { hard: Some(hard), ..Default::default() }),
                    status: None,
                })));
                // A quota on cpu/memory rejects pods without requests/limits;
                // these defaults keep operator-generated pods schedulable.
                objects.push(Obj::new("limitrange", seen("limitrange"), to_value(&LimitRange {
                    metadata: self.meta("project-defaults"),
                    spec: Some(LimitRangeSpec { limits: vec![LimitRangeItem {
                        type_: "Container".into(),
                        default_request: Some(quantity_map(&[("cpu", "50m"), ("memory", "64Mi")])),
                        default: Some(quantity_map(&[("memory", "256Mi")])),
                        ..Default::default()
                    }] }),
                })));
            }
        }

        // ---- backup bucket reachability: WAL archiving runs here, so it is
        // checked from here, with this location's keys, every few minutes.
        let mut check_state = Map::new();
        if let (Some(check), false) = (check, local) {
            let mut secret = Obj::new("backup-check-s3", seen("backup-check-s3"),
                to_value(&Secret { metadata: self.meta("backup-check-s3"), ..Default::default() }));
            secret.copy_from = format!("{}/backup-s3-{}", self.ns, m.location);
            objects.push(secret);
            objects.push(Obj::new("backup-check", seen("backup-check"), self.backup_check_cron_job(m, check)));
            // Unknown until the first run; Checking while one runs after a failure.
            let cj = as_obj(observed.get("backup-check").and_then(|o| o.get("status")));
            let scheduled = as_str(cj.get("lastScheduleTime")).to_string();
            let succeeded = as_str(cj.get("lastSuccessfulTime")).to_string();
            let active = cj.get("active");
            let state = if !succeeded.is_empty() && succeeded >= scheduled {
                "Reachable"
            } else if !empty(active) && !active.and_then(Value::as_array).is_some_and(|l| l.is_empty()) {
                "Checking"
            } else if !scheduled.is_empty() {
                "Unreachable"
            } else {
                "Pending"
            };
            check_state.insert("state".into(), json!(state));
            if !scheduled.is_empty() {
                check_state.insert("lastCheckTime".into(), json!(scheduled));
            }
            if !succeeded.is_empty() {
                check_state.insert("lastSuccessTime".into(), json!(succeeded));
            }
        }

        let mut waiting = vec![];
        if !ns_ready {
            waiting.push("namespace".to_string());
        }
        if prom_enabled && !prom_ready {
            waiting.push("Prometheus".into());
        }
        if graf_enabled && !graf_ready {
            waiting.push("Grafana".into());
        }
        (objects, MemberStatus { location: m.location.clone(), site: m.site.clone(), waiting, problem: String::new(), backup_check: check_state })
    }

    #[allow(clippy::too_many_arguments)]
    fn prometheus_spec(&self, m: &Member, prom: &Map<String, Value>, cm_enabled: bool, cm_namespace: &str, cm_labels: &Map<String, Value>,
        cm_exclude: &[Value], om_enabled: bool, om_namespace: &str) -> p::PrometheusSpec {
        let pv = Value::Object(prom.clone());
        let resource = |path: &[&str], def: &str| or(as_str(dig(&pv, path)), def).to_string();
        let mut spec = p::PrometheusSpec {
            service_account_name: Some("prometheus".into()),
            replicas: Some(1),
            retention: Some(or(as_str(prom.get("retention")), "7d").into()),
            resources: Some(p::PrometheusResources {
                requests: Some(quantities(Labels::from([
                    ("cpu".to_string(), resource(&["resources", "requests", "cpu"], "100m")),
                    ("memory".to_string(), resource(&["resources", "requests", "memory"], "512Mi")),
                ]))),
                limits: Some(quantities(Labels::from([("memory".to_string(), resource(&["resources", "limits", "memory"], "2Gi"))]))),
                ..Default::default()
            }),
            // Without fsGroup the PVC stays root-owned and Prometheus (non-root)
            // crashes on "open /prometheus/queries.active".
            security_context: Some(retype(&PodSecurityContext {
                run_as_non_root: Some(true), run_as_user: Some(1000), run_as_group: Some(2000), fs_group: Some(2000),
                seccomp_profile: Some(SeccompProfile { type_: "RuntimeDefault".into(), ..Default::default() }),
                ..Default::default()
            })),
            storage: Some(p::PrometheusStorage {
                volume_claim_template: Some(p::PrometheusStorageVolumeClaimTemplate { spec: Some(retype(&pvc_spec(prom))), ..Default::default() }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let names = |key: &str, op: &str, values: Vec<String>| LabelSelector {
            match_expressions: Some(vec![LabelSelectorRequirement { key: key.into(), operator: op.into(), values: Some(values) }]),
            ..Default::default()
        };
        let labels = |l: Labels| LabelSelector { match_labels: Some(l), ..Default::default() };
        let one = |k: &str, v: &str| Labels::from([(k.to_string(), v.to_string())]);
        if m.local() {
            // The Prometheus in the project's locations writes here.
            spec.enable_remote_write_receiver = Some(true);
            if self.gov.prices.is_some() {
                // The cost rules (governance.rs), over every location's series.
                spec.rule_selector = Some(retype(&labels(one("platform.cndev.nl/project", &self.name))));
                spec.rule_namespace_selector = Some(retype(&labels(one("kubernetes.io/metadata.name", &self.ns))));
            }
            return spec;
        }
        // Tells this location's series apart in the shared Grafana.
        spec.external_labels = Some(Labels::from([("location".to_string(), m.location.clone()), ("site".to_string(), m.site.clone())]));
        if !self.rw_url.is_empty() {
            spec.remote_write = Some(vec![p::PrometheusRemoteWrite { url: self.rw_url.clone(), ..Default::default() }]);
        }
        // Every PodMonitor in this namespace (what the workloads create) and,
        // with operator metrics on, the CNPG operator's.
        spec.pod_monitor_selector = Some(Default::default());
        if om_enabled {
            spec.pod_monitor_namespace_selector =
                Some(retype(&names("kubernetes.io/metadata.name", "In", vec![self.ns.clone(), om_namespace.into()])));
        }
        // Rules from this namespace and, with cluster metrics on,
        // kube-prometheus-stack's recording rules the dashboards' CPU panels query.
        let mut rule_namespaces = vec![self.ns.clone()];
        if cm_enabled {
            rule_namespaces.push(cm_namespace.into());
        }
        spec.rule_selector = Some(Default::default());
        spec.rule_namespace_selector = Some(retype(&names("kubernetes.io/metadata.name", "In", rule_namespaces)));
        if cm_enabled {
            // Only the node/container ServiceMonitors from kube-prometheus-stack,
            // not the control-plane ones.
            spec.service_monitor_namespace_selector = Some(retype(&labels(one("kubernetes.io/metadata.name", cm_namespace))));
            let mut sel = labels(cm_labels.iter().map(|(k, v)| (k.clone(), sprint(v))).collect());
            if !cm_exclude.is_empty() {
                sel.match_expressions = names("app", "NotIn", cm_exclude.iter().map(sprint).collect()).match_expressions;
            }
            spec.service_monitor_selector = Some(retype(&sel));
        }
        spec
    }

    fn grafana(&self, host: &str, scope: &Labels) -> Value {
        let mut labels = self.labels();
        labels.extend(scope.clone());
        let section = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
        let mut config = BTreeMap::from([
            // The portal embeds the dashboards in an iframe.
            ("security".to_string(), section(&[("allow_embedding", "true")])),
            // Read-only anonymous access so the iframe works without a login.
            // Admin login: Secret grafana-admin-credentials.
            ("auth.anonymous".to_string(), section(&[("enabled", "true"), ("org_role", "Viewer")])),
        ]);
        let mut spec = g::GrafanaSpec::default();
        if !host.is_empty() {
            config.insert("server".into(), section(&[("root_url", &format!("{}://{host}", self.scheme))]));
            let ing = ingress_spec(host, "/", "Prefix", "grafana-service", 3000,
                as_str(self.ingress.get("className")), as_str(self.ingress.get("tlsSecretName")));
            spec.ingress = Some(g::GrafanaIngress { spec: Some(retype(&ing)), metadata: None });
        }
        spec.config = Some(config);
        to_value(&g::Grafana { metadata: meta("grafana", &self.ns, &labels), spec, status: None })
    }

    /// Exposes only the remote-write path: the Prometheus in the locations
    /// push through it. Restrict it with ingress annotations from
    /// project-defaults (prometheus.remoteWrite.annotations).
    fn remote_write_ingress(&self) -> Value {
        let ann = as_obj(self.remote_write.get("annotations"));
        to_value(&Ingress {
            metadata: ObjectMeta {
                annotations: map_opt(ann.iter().map(|(k, v)| (k.clone(), sprint(v))).collect()),
                ..self.meta("prometheus-remote-write")
            },
            spec: Some(ingress_spec(&self.rw_host, "/api/v1/write", "Exact", "prometheus-operated", 9090,
                as_str(self.remote_write.get("className")), as_str(self.remote_write.get("tlsSecretName")))),
            status: None,
        })
    }

    fn backup_check_cron_job(&self, m: &Member, check: &BackupCheck) -> Value {
        let value = |name: &str, value: &str| EnvVar { name: name.into(), value: Some(value.into()), ..Default::default() };
        let mut env = vec![value("LOCATION", &m.location), value("S3_ENDPOINT", &check.endpoint), value("S3_BUCKET", &check.bucket)];
        for k in ["ACCESS_KEY_ID", "ACCESS_SECRET_KEY", "REGION"] {
            env.push(EnvVar {
                name: k.into(),
                value_from: Some(EnvVarSource {
                    secret_key_ref: Some(SecretKeySelector {
                        name: "backup-check-s3".into(), key: k.into(), optional: (k == "REGION").then_some(true),
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            });
        }
        let mut pod_labels = self.labels();
        pod_labels.insert("platform.cndev.nl/check".into(), "backup".into());
        let strings = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let pod = PodSpec {
            restart_policy: Some("Never".into()),
            automount_service_account_token: Some(false),
            // Numeric, so the kubelet can verify non-root for images
            // whose USER is a name (curlimages/curl runs as "curl_user").
            security_context: Some(PodSecurityContext {
                run_as_non_root: Some(true), run_as_user: Some(65534), run_as_group: Some(65534),
                seccomp_profile: Some(SeccompProfile { type_: "RuntimeDefault".into(), ..Default::default() }),
                ..Default::default()
            }),
            containers: vec![Container {
                name: "check".into(),
                image: Some(check.image.clone()),
                command: Some(strings(&["sh", "-c"])),
                args: Some(vec![BACKUP_CHECK_SCRIPT.into()]),
                env: Some(env),
                resources: Some(ResourceRequirements {
                    requests: Some(quantity_map(&[("cpu", "10m"), ("memory", "16Mi")])),
                    limits: Some(quantity_map(&[("memory", "64Mi")])),
                    ..Default::default()
                }),
                security_context: Some(SecurityContext {
                    allow_privilege_escalation: Some(false), read_only_root_filesystem: Some(true),
                    capabilities: Some(Capabilities { drop: Some(strings(&["ALL"])), ..Default::default() }),
                    ..Default::default()
                }),
                volume_mounts: Some(vec![VolumeMount { name: "tmp".into(), mount_path: "/tmp".into(), ..Default::default() }]),
                ..Default::default()
            }],
            volumes: Some(vec![Volume {
                name: "tmp".into(),
                empty_dir: Some(EmptyDirVolumeSource { size_limit: Some(Quantity("1Mi".into())), ..Default::default() }),
                ..Default::default()
            }]),
            ..Default::default()
        };
        to_value(&CronJob {
            metadata: self.meta("backup-check"),
            spec: CronJobSpec {
                schedule: check.schedule.clone(),
                concurrency_policy: Some("Forbid".into()),
                successful_jobs_history_limit: Some(1),
                failed_jobs_history_limit: Some(1),
                job_template: JobTemplateSpec {
                    spec: Some(JobSpec {
                        backoff_limit: Some(0),
                        active_deadline_seconds: Some(120),
                        template: PodTemplateSpec {
                            metadata: Some(ObjectMeta { labels: Some(pod_labels), ..Default::default() }),
                            spec: Some(pod),
                        },
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                ..Default::default()
            },
            status: None,
        })
    }

    /// Puts a location's object into a provider-kubernetes Object for the
    /// ClusterProviderConfig named after the location.
    pub(super) fn wrap(&self, key: &str, location: &str, o: Obj) -> Composed {
        // The Secret's data comes from the control plane, never through this spec.
        let references = if o.copy_from.is_empty() {
            vec![]
        } else {
            let (from_ns, from_name) = o.copy_from.split_once('/').unwrap_or(("", &o.copy_from));
            secret_copy(from_ns, from_name)
        };
        let mut object = location_object(meta(key, &self.ns, &self.labels()), location, o.manifest, references);
        if o.orphan {
            // Never delete the namespace in another location: workloads may
            // still run there (no Delete in the management policies).
            object.spec.management_policies = Some(["Observe", "Create", "Update", "LateInitialize"].map(String::from).to_vec());
        }
        Composed { ready: o.ready, object: to_value(&object) }
    }
}

/// An Ingress spec with one rule: host's path to service:port.
fn ingress_spec(host: &str, path: &str, path_type: &str, service: &str, port: i32, class: &str, tls_secret: &str) -> IngressSpec {
    IngressSpec {
        ingress_class_name: str_opt(class),
        rules: Some(vec![IngressRule {
            host: Some(host.into()),
            http: Some(HTTPIngressRuleValue { paths: vec![HTTPIngressPath {
                path: Some(path.into()),
                path_type: path_type.into(),
                backend: IngressBackend {
                    service: Some(IngressServiceBackend {
                        name: service.into(),
                        port: Some(ServiceBackendPort { number: Some(port), ..Default::default() }),
                    }),
                    ..Default::default()
                },
            }] }),
        }]),
        tls: (!tls_secret.is_empty()).then(|| vec![IngressTLS { hosts: Some(vec![host.into()]), secret_name: Some(tls_secret.into()) }]),
        ..Default::default()
    }
}

fn quantity_map(pairs: &[(&str, &str)]) -> BTreeMap<String, Quantity> {
    pairs.iter().map(|(k, v)| (k.to_string(), Quantity(v.to_string()))).collect()
}

fn pvc_spec(prom: &Map<String, Value>) -> PersistentVolumeClaimSpec {
    let p = Value::Object(prom.clone());
    PersistentVolumeClaimSpec {
        access_modes: Some(vec!["ReadWriteOnce".into()]),
        resources: Some(VolumeResourceRequirements {
            requests: Some(quantity_map(&[("storage", or(as_str(dig(&p, &["storage", "size"])), "10Gi"))])),
            ..Default::default()
        }),
        storage_class_name: str_opt(as_str(dig(&p, &["storage", "storageClass"]))),
        ..Default::default()
    }
}
