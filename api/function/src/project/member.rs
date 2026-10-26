//! What a Project runs on the control plane and in each of its locations.

use serde_json::{Map, Value, json};

use super::{BackupCheck, Member, MemberStatus, Settings, empty};
use crate::common::gojson::sprint;
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
        let scope = json!({"dashboards.paas.cndev.nl/scope": self.ns});

        let ns_obs = observed.get("namespace");
        let ns_ready = ns_obs.is_some_and(|n| as_str(dig(n, &["status", "phase"])) == "Active");
        let prom_ready = observed.get("prometheus").is_some_and(|p| condition_true(Some(p), "Available"));
        let graf_ready = observed.get("grafana").is_some_and(|g| {
            as_str(dig(g, &["status", "stage"])) == "complete" && as_str(dig(g, &["status", "stageStatus"])) == "success"
        });
        let seen = |key: &str| observed.contains_key(key);

        let mut objects: Vec<Obj> = vec![];

        // ---- the namespace
        let mut ns_ann = Map::new();
        let d = as_str(self.spec.get("description"));
        if !d.is_empty() {
            ns_ann.insert("platform.cndev.nl/description".into(), json!(d));
        }
        if local {
            // Read by the admission policies and the workload compositions.
            let l = as_str(dig(&spec, &["locations", "protected"]));
            if !l.is_empty() {
                ns_ann.insert("platform.cndev.nl/protected-location".into(), json!(l));
            }
            let l = as_str(dig(&spec, &["locations", "recovery"]));
            if !l.is_empty() {
                ns_ann.insert("platform.cndev.nl/recovery-location".into(), json!(l));
            }
            if self.bucket_on {
                // PostgresClusters may then leave backup.destinationPath out.
                ns_ann.insert("platform.cndev.nl/backup-bucket".into(), json!("true"));
            }
            if !unschedulable.is_empty() {
                // Locations whose Location says schedulable: false; the same
                // policies refuse workloads that newly add them.
                ns_ann.insert("platform.cndev.nl/unschedulable-locations".into(), json!(unschedulable.join(",")));
            }
        }
        let mut ns_labels = self.labels.clone();
        ns_labels.insert("dashboards.paas.cndev.nl/scope".into(), json!(self.ns));
        let o = as_str(self.spec.get("owner"));
        if !o.is_empty() {
            ns_labels.insert("backstage.io/owner".into(), json!(o));
        }
        for (k, v) in self.gov.labels() {
            ns_labels.insert(k, json!(v));
        }
        // CNPG, Prometheus and Grafana all run under "baseline"; "restricted"
        // warnings flag workloads to harden.
        ns_labels.insert("pod-security.kubernetes.io/enforce".into(), json!("baseline"));
        ns_labels.insert("pod-security.kubernetes.io/warn".into(), json!("restricted"));
        let mut ns_meta = json!({"name": self.ns, "labels": ns_labels});
        if !ns_ann.is_empty() {
            ns_meta["annotations"] = Value::Object(ns_ann);
        }
        let mut ns = Obj::new("namespace", ns_ready, json!({"apiVersion": "v1", "kind": "Namespace", "metadata": ns_meta}));
        ns.orphan = !local;
        objects.push(ns);

        if prom_enabled && !local {
            // Cluster-wide: kubelet/cAdvisor targets live on the nodes and
            // kube-state-metrics/node-exporter in the kube-prometheus-stack
            // namespace. One shared ClusterRole, one binding per project. (Named
            // basis:..., not platform:..., since its roleRef moved from
            // cnpg-platform:project-prometheus: a roleRef can't change in place.)
            objects.push(Obj::new("prometheus-clusterrolebinding", seen("prometheus-clusterrolebinding"), json!({
                "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
                "metadata": {"name": format!("basis:project:{}:prometheus", self.name), "labels": self.labels},
                "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "basis:project-prometheus"},
                "subjects": [{"kind": "ServiceAccount", "name": "prometheus", "namespace": self.ns}],
            })));
        }

        if ns_obs.is_some() {
            if prom_enabled {
                objects.push(Obj::new("prometheus-serviceaccount", seen("prometheus-serviceaccount"),
                    json!({"apiVersion": "v1", "kind": "ServiceAccount", "metadata": self.meta("prometheus")})));
                objects.push(Obj::new("prometheus", prom_ready, json!({
                    "apiVersion": "monitoring.coreos.com/v1", "kind": "Prometheus", "metadata": self.meta("prometheus"),
                    "spec": self.prometheus_spec(m, &prom, cm_enabled, &cm_namespace, &cm_labels, &cm_exclude, om_enabled, &om_namespace),
                })));
                // The Prometheus StatefulSet's volume, composed so that growing
                // spec.observability.prometheus.storage.size grows the PVC: a
                // StatefulSet never resizes its volumeClaimTemplate's PVCs. Named
                // as the StatefulSet would name it. Bound only once the pod is
                // scheduled (WaitForFirstConsumer); the Prometheus' readiness
                // already covers that.
                objects.push(Obj::new("prometheus-pvc", true, json!({
                    "apiVersion": "v1", "kind": "PersistentVolumeClaim",
                    "metadata": self.meta("prometheus-prometheus-db-prometheus-prometheus-0"),
                    "spec": pvc_spec(&prom),
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
                    objects.push(Obj::new("grafana-datasource", seen("grafana-datasource"), json!({
                        "apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDatasource", "metadata": self.meta("prometheus"),
                        "spec": {
                            "instanceSelector": {"matchLabels": scope},
                            "datasource": {"name": "prometheus", "type": "prometheus", "access": "proxy",
                                "url": format!("http://prometheus-operated.{}.svc:9090", self.ns), "isDefault": true},
                        },
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
                    let mut meta = self.meta(&format!("project-{}-{}", as_str(a.get("role")), trunc(&sha1hex(group), 8)));
                    meta["annotations"] = json!({"platform.cndev.nl/group": group});
                    objects.push(Obj::new(&key, seen(&key), json!({
                        "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": meta,
                        "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": a.get("role").cloned().unwrap_or(Value::Null)},
                        "subjects": [{"apiGroup": "rbac.authorization.k8s.io", "kind": "Group", "name": group}],
                    })));
                }
            }

            // The quota is for the workloads: none on the control plane.
            if !quota.is_empty() && !local {
                let mut hard = Map::new();
                let v = as_str(quota.get("cpu"));
                if !v.is_empty() {
                    hard.insert("requests.cpu".into(), json!(v));
                }
                let v = as_str(quota.get("memory"));
                if !v.is_empty() {
                    hard.insert("requests.memory".into(), json!(v));
                    hard.insert("limits.memory".into(), json!(v));
                }
                let v = as_str(quota.get("storage"));
                if !v.is_empty() {
                    hard.insert("requests.storage".into(), json!(v));
                }
                objects.push(Obj::new("quota", seen("quota"), json!({
                    "apiVersion": "v1", "kind": "ResourceQuota", "metadata": self.meta("project"), "spec": {"hard": hard},
                })));
                // A quota on cpu/memory rejects pods without requests/limits;
                // these defaults keep operator-generated pods schedulable.
                objects.push(Obj::new("limitrange", seen("limitrange"), json!({
                    "apiVersion": "v1", "kind": "LimitRange", "metadata": self.meta("project-defaults"),
                    "spec": {"limits": [{"type": "Container",
                        "defaultRequest": {"cpu": "50m", "memory": "64Mi"},
                        "default": {"memory": "256Mi"}}]},
                })));
            }
        }

        // ---- backup bucket reachability: WAL archiving runs here, so it is
        // checked from here, with this location's keys, every few minutes.
        let mut check_state = Map::new();
        if let (Some(check), false) = (check, local) {
            let mut secret = Obj::new("backup-check-s3", seen("backup-check-s3"),
                json!({"apiVersion": "v1", "kind": "Secret", "metadata": self.meta("backup-check-s3")}));
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
        cm_exclude: &[Value], om_enabled: bool, om_namespace: &str) -> Value {
        let p = Value::Object(prom.clone());
        let mut spec = json!({
            "serviceAccountName": "prometheus",
            "replicas": 1,
            "retention": or(as_str(prom.get("retention")), "7d"),
            "resources": {
                "requests": {"cpu": or(as_str(dig(&p, &["resources", "requests", "cpu"])), "100m"),
                    "memory": or(as_str(dig(&p, &["resources", "requests", "memory"])), "512Mi")},
                "limits": {"memory": or(as_str(dig(&p, &["resources", "limits", "memory"])), "2Gi")},
            },
            // Without fsGroup the PVC stays root-owned and Prometheus (non-root)
            // crashes on "open /prometheus/queries.active".
            "securityContext": {"runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 2000, "fsGroup": 2000,
                "seccompProfile": {"type": "RuntimeDefault"}},
            "storage": {"volumeClaimTemplate": {"spec": pvc_spec(prom)}},
        });
        if m.local() {
            // The Prometheus in the project's locations writes here.
            spec["enableRemoteWriteReceiver"] = json!(true);
            if self.gov.prices.is_some() {
                // The cost rules (governance.rs), over every location's series.
                spec["ruleSelector"] = json!({"matchLabels": {"platform.cndev.nl/project": self.name}});
                spec["ruleNamespaceSelector"] = json!({"matchLabels": {"kubernetes.io/metadata.name": self.ns}});
            }
            return spec;
        }
        // Tells this location's series apart in the shared Grafana.
        spec["externalLabels"] = json!({"location": m.location, "site": m.site});
        if !self.rw_url.is_empty() {
            spec["remoteWrite"] = json!([{"url": self.rw_url}]);
        }
        // Every PodMonitor in this namespace (what the workloads create) and,
        // with operator metrics on, the CNPG operator's.
        spec["podMonitorSelector"] = json!({});
        if om_enabled {
            spec["podMonitorNamespaceSelector"] = json!({"matchExpressions": [{
                "key": "kubernetes.io/metadata.name", "operator": "In", "values": [self.ns, om_namespace]}]});
        }
        // Rules from this namespace and, with cluster metrics on,
        // kube-prometheus-stack's recording rules the dashboards' CPU panels query.
        let mut rule_namespaces = vec![json!(self.ns)];
        if cm_enabled {
            rule_namespaces.push(json!(cm_namespace));
        }
        spec["ruleSelector"] = json!({});
        spec["ruleNamespaceSelector"] = json!({"matchExpressions": [{
            "key": "kubernetes.io/metadata.name", "operator": "In", "values": rule_namespaces}]});
        if cm_enabled {
            // Only the node/container ServiceMonitors from kube-prometheus-stack,
            // not the control-plane ones.
            spec["serviceMonitorNamespaceSelector"] = json!({"matchLabels": {"kubernetes.io/metadata.name": cm_namespace}});
            let labels: Map<String, Value> = cm_labels.iter().map(|(k, v)| (k.clone(), json!(sprint(v)))).collect();
            let mut sel = json!({"matchLabels": labels});
            if !cm_exclude.is_empty() {
                sel["matchExpressions"] = json!([{"key": "app", "operator": "NotIn", "values": cm_exclude}]);
            }
            spec["serviceMonitorSelector"] = sel;
        }
        spec
    }

    fn grafana(&self, host: &str, scope: &Value) -> Value {
        let mut labels = self.labels.clone();
        labels.insert("dashboards.paas.cndev.nl/scope".into(), scope["dashboards.paas.cndev.nl/scope"].clone());
        let mut config = json!({
            // The portal embeds the dashboards in an iframe.
            "security": {"allow_embedding": "true"},
            // Read-only anonymous access so the iframe works without a login.
            // Admin login: Secret grafana-admin-credentials.
            "auth.anonymous": {"enabled": "true", "org_role": "Viewer"},
        });
        let mut spec = json!({});
        if !host.is_empty() {
            config["server"] = json!({"root_url": format!("{}://{host}", self.scheme)});
            let mut ing = json!({"rules": [{"host": host, "http": {"paths": [{
                "path": "/", "pathType": "Prefix",
                "backend": {"service": {"name": "grafana-service", "port": {"number": 3000}}},
            }]}}]});
            let c = as_str(self.ingress.get("className"));
            if !c.is_empty() {
                ing["ingressClassName"] = json!(c);
            }
            let t = as_str(self.ingress.get("tlsSecretName"));
            if !t.is_empty() {
                ing["tls"] = json!([{"hosts": [host], "secretName": t}]);
            }
            spec["ingress"] = json!({"spec": ing});
        }
        spec["config"] = config;
        json!({
            "apiVersion": "grafana.integreatly.org/v1beta1", "kind": "Grafana",
            "metadata": {"name": "grafana", "namespace": self.ns, "labels": labels},
            "spec": spec,
        })
    }

    /// Exposes only the remote-write path: the Prometheus in the locations
    /// push through it. Restrict it with ingress annotations from
    /// project-defaults (prometheus.remoteWrite.annotations).
    fn remote_write_ingress(&self) -> Value {
        let mut meta = self.meta("prometheus-remote-write");
        let ann = as_obj(self.remote_write.get("annotations"));
        if !ann.is_empty() {
            meta["annotations"] = Value::Object(ann.iter().map(|(k, v)| (k.clone(), json!(sprint(v)))).collect());
        }
        let mut spec = json!({"rules": [{"host": self.rw_host, "http": {"paths": [{
            "path": "/api/v1/write", "pathType": "Exact",
            "backend": {"service": {"name": "prometheus-operated", "port": {"number": 9090}}},
        }]}}]});
        let c = as_str(self.remote_write.get("className"));
        if !c.is_empty() {
            spec["ingressClassName"] = json!(c);
        }
        let t = as_str(self.remote_write.get("tlsSecretName"));
        if !t.is_empty() {
            spec["tls"] = json!([{"hosts": [self.rw_host], "secretName": t}]);
        }
        json!({"apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": meta, "spec": spec})
    }

    fn backup_check_cron_job(&self, m: &Member, check: &BackupCheck) -> Value {
        let mut env = vec![
            json!({"name": "LOCATION", "value": m.location}),
            json!({"name": "S3_ENDPOINT", "value": check.endpoint}),
            json!({"name": "S3_BUCKET", "value": check.bucket}),
        ];
        for k in ["ACCESS_KEY_ID", "ACCESS_SECRET_KEY", "REGION"] {
            let mut r = json!({"name": "backup-check-s3", "key": k});
            if k == "REGION" {
                r["optional"] = json!(true);
            }
            env.push(json!({"name": k, "valueFrom": {"secretKeyRef": r}}));
        }
        let mut pod_labels = self.labels.clone();
        pod_labels.insert("platform.cndev.nl/check".into(), json!("backup"));
        json!({
            "apiVersion": "batch/v1", "kind": "CronJob", "metadata": self.meta("backup-check"),
            "spec": {
                "schedule": check.schedule, "concurrencyPolicy": "Forbid",
                "successfulJobsHistoryLimit": 1, "failedJobsHistoryLimit": 1,
                "jobTemplate": {"spec": {
                    "backoffLimit": 0, "activeDeadlineSeconds": 120,
                    "template": {
                        "metadata": {"labels": pod_labels},
                        "spec": {
                            "restartPolicy": "Never", "automountServiceAccountToken": false,
                            // Numeric, so the kubelet can verify non-root for images
                            // whose USER is a name (curlimages/curl runs as "curl_user").
                            "securityContext": {"runAsNonRoot": true, "runAsUser": 65534, "runAsGroup": 65534,
                                "seccompProfile": {"type": "RuntimeDefault"}},
                            "containers": [{
                                "name": "check", "image": check.image,
                                "command": ["sh", "-c"], "args": [BACKUP_CHECK_SCRIPT],
                                "env": env,
                                "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "64Mi"}},
                                "securityContext": {"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true,
                                    "capabilities": {"drop": ["ALL"]}},
                                "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}],
                            }],
                            "volumes": [{"name": "tmp", "emptyDir": {"sizeLimit": "1Mi"}}],
                        },
                    },
                }},
            },
        })
    }

    /// Puts a location's object into a provider-kubernetes Object for the
    /// ClusterProviderConfig named after the location.
    pub(super) fn wrap(&self, key: &str, location: &str, o: Obj) -> Composed {
        let mut spec = json!({
            "providerConfigRef": {"kind": "ClusterProviderConfig", "name": location},
            "watch": true,
            "forProvider": {"manifest": o.manifest},
        });
        if o.orphan {
            // Never delete the namespace in another location: workloads may
            // still run there (no Delete in the management policies).
            spec["managementPolicies"] = json!(["Observe", "Create", "Update", "LateInitialize"]);
        }
        if !o.copy_from.is_empty() {
            let (from_ns, from_name) = o.copy_from.split_once('/').unwrap_or(("", &o.copy_from));
            // The Secret's data comes from the control plane, never through this spec.
            spec["references"] = json!(["data", "type"].iter().map(|f| json!({"patchesFrom": {"apiVersion": "v1", "kind": "Secret",
                "name": from_name, "namespace": from_ns, "fieldPath": f}})).collect::<Vec<_>>());
        }
        Composed { ready: o.ready, object: json!({
            "apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
            "metadata": {"name": key, "namespace": self.ns, "labels": self.labels,
                "annotations": {"platform.cndev.nl/location": location}},
            "spec": spec,
        })}
    }
}

fn pvc_spec(prom: &Map<String, Value>) -> Value {
    let p = Value::Object(prom.clone());
    let mut spec = json!({
        "accessModes": ["ReadWriteOnce"],
        "resources": {"requests": {"storage": or(as_str(dig(&p, &["storage", "size"])), "10Gi")}},
    });
    let sc = as_str(dig(&p, &["storage", "storageClass"]));
    if !sc.is_empty() {
        spec["storageClassName"] = json!(sc);
    }
    spec
}
