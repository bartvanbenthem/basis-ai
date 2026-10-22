package project

import (
	"fmt"
	"strings"
)

// object is one of a member's objects, by composition resource name.
type object struct {
	key      string
	manifest Object
	ready    bool
	orphan   bool   // in a location: never deleted by Crossplane
	copyFrom string // in a location: a Secret whose data comes from <ns>/<name> on the control plane
}

// member renders the namespace and what's in it for the control plane or
// one location, and what it waits for.
func (s *settings) member(m *member, unschedulable []string, check *backupCheck) ([]object, memberStatus) {
	local := m.local()
	observed := m.observed
	env := s.env
	clusterMetrics := obj(dig(env, "prometheus", "clusterMetrics"))
	cmEnabled := boolOr(clusterMetrics["enabled"], true)
	cmNamespace := or(str(clusterMetrics["namespace"]), "prometheus-operator-system")
	cmLabels := Object{"release": "prometheus-operator"}
	if l, ok := clusterMetrics["serviceMonitorLabels"].(Object); ok {
		cmLabels = l
	}
	cmExclude := []any{"kube-prometheus-stack-apiserver", "kube-prometheus-stack-coredns", "kube-prometheus-stack-kube-controller-manager",
		"kube-prometheus-stack-kube-etcd", "kube-prometheus-stack-kube-proxy", "kube-prometheus-stack-kube-scheduler", "kube-prometheus-stack-operator"}
	if l, ok := clusterMetrics["excludeApps"].([]any); ok {
		cmExclude = l
	}
	operatorMetrics := obj(dig(env, "prometheus", "operatorMetrics"))
	omEnabled := boolOr(operatorMetrics["enabled"], true)
	omNamespace := or(str(operatorMetrics["namespace"]), "cnpg-system")

	obs := obj(s.spec["observability"])
	prom := obj(obs["prometheus"])
	promEnabled := boolOr(prom["enabled"], true)
	graf := obj(obs["grafana"])
	grafEnabled := local && boolOr(graf["enabled"], true)
	host := ""
	if tpl := str(s.ingress["hostTemplate"]); grafEnabled && boolOr(graf["ingress"], true) && tpl != "" {
		host = strings.ReplaceAll(tpl, "{project}", s.name)
	}
	quota := obj(s.spec["quota"])
	scope := Object{"dashboards.paas.cndev.nl/scope": s.ns}

	nsObs := observed["namespace"]
	nsReady := nsObs != nil && str(dig(nsObs, "status", "phase")) == "Active"
	promReady := false
	if p := observed["prometheus"]; p != nil {
		promReady = conditionTrue(p, "Available")
	}
	grafReady := false
	if g := observed["grafana"]; g != nil {
		grafReady = str(dig(g, "status", "stage")) == "complete" && str(dig(g, "status", "stageStatus")) == "success"
	}
	seen := func(key string) bool { return observed[key] != nil }

	var objects []object
	add := func(o object) { objects = append(objects, o) }

	// ---- the namespace
	nsAnn := Object{}
	if d := str(s.spec["description"]); d != "" {
		nsAnn["platform.cndev.nl/description"] = d
	}
	if local {
		// Read by the admission policies and the workload compositions.
		if l := str(dig(s.spec, "locations", "protected")); l != "" {
			nsAnn["platform.cndev.nl/protected-location"] = l
		}
		if l := str(dig(s.spec, "locations", "recovery")); l != "" {
			nsAnn["platform.cndev.nl/recovery-location"] = l
		}
		if s.bucketOn {
			// PostgresClusters may then leave backup.destinationPath out.
			nsAnn["platform.cndev.nl/backup-bucket"] = "true"
		}
		if len(unschedulable) > 0 {
			// Locations whose Location says schedulable: false; the same
			// policies refuse workloads that newly add them.
			nsAnn["platform.cndev.nl/unschedulable-locations"] = strings.Join(unschedulable, ",")
		}
	}
	nsLabels := s.labelsObj()
	for k, v := range scope {
		nsLabels[k] = v
	}
	if o := str(s.spec["owner"]); o != "" {
		nsLabels["backstage.io/owner"] = o
	}
	for k, v := range s.gov.labels() {
		nsLabels[k] = v
	}
	// CNPG, Prometheus and Grafana all run under "baseline"; "restricted"
	// warnings flag workloads to harden.
	nsLabels["pod-security.kubernetes.io/enforce"] = "baseline"
	nsLabels["pod-security.kubernetes.io/warn"] = "restricted"
	nsMeta := Object{"name": s.ns, "labels": nsLabels}
	if len(nsAnn) > 0 {
		nsMeta["annotations"] = nsAnn
	}
	add(object{key: "namespace", ready: nsReady, orphan: !local,
		manifest: Object{"apiVersion": "v1", "kind": "Namespace", "metadata": nsMeta}})

	if promEnabled && !local {
		// Cluster-wide: kubelet/cAdvisor targets live on the nodes and
		// kube-state-metrics/node-exporter in the kube-prometheus-stack
		// namespace. One shared ClusterRole, one binding per project. (Named
		// basis:..., not platform:..., since its roleRef moved from
		// cnpg-platform:project-prometheus: a roleRef can't change in place.)
		add(object{key: "prometheus-clusterrolebinding", ready: seen("prometheus-clusterrolebinding"), manifest: Object{
			"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
			"metadata": Object{"name": fmt.Sprintf("basis:project:%s:prometheus", s.name), "labels": s.labelsObj()},
			"roleRef":  Object{"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "basis:project-prometheus"},
			"subjects": []any{Object{"kind": "ServiceAccount", "name": "prometheus", "namespace": s.ns}},
		}})
	}

	if nsObs != nil {
		if promEnabled {
			add(object{key: "prometheus-serviceaccount", ready: seen("prometheus-serviceaccount"),
				manifest: Object{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": s.meta("prometheus")}})
			add(object{key: "prometheus", ready: promReady, manifest: Object{
				"apiVersion": "monitoring.coreos.com/v1", "kind": "Prometheus", "metadata": s.meta("prometheus"),
				"spec": s.prometheusSpec(m, prom, cmEnabled, cmNamespace, cmLabels, cmExclude, omEnabled, omNamespace),
			}})
			// The Prometheus StatefulSet's volume, composed so that growing
			// spec.observability.prometheus.storage.size grows the PVC: a
			// StatefulSet never resizes its volumeClaimTemplate's PVCs. Named
			// as the StatefulSet would name it.
			// Bound only once the pod is scheduled (WaitForFirstConsumer);
			// the Prometheus' readiness already covers that.
			add(object{key: "prometheus-pvc", ready: true, manifest: Object{
				"apiVersion": "v1", "kind": "PersistentVolumeClaim",
				"metadata": s.meta("prometheus-prometheus-db-prometheus-prometheus-0"),
				"spec":     pvcSpec(prom),
			}})
			// The project's cost, from what its locations write here.
			if local && s.gov.prices != nil {
				add(object{key: "cost-rules", ready: seen("cost-rules"), manifest: s.gov.costRules(s)})
				if grafEnabled {
					add(object{key: "cost-dashboard", ready: seen("cost-dashboard"), manifest: s.gov.costDashboard(s)})
				}
			}
		}

		if grafEnabled {
			add(object{key: "grafana", ready: grafReady, manifest: s.grafana(host, scope)})
			if promEnabled {
				// Named "prometheus": the datasource name the workloads'
				// dashboards are wired to.
				add(object{key: "grafana-datasource", ready: seen("grafana-datasource"), manifest: Object{
					"apiVersion": "grafana.integreatly.org/v1beta1", "kind": "GrafanaDatasource", "metadata": s.meta("prometheus"),
					"spec": Object{
						"instanceSelector": Object{"matchLabels": scope},
						"datasource": Object{"name": "prometheus", "type": "prometheus", "access": "proxy",
							"url": fmt.Sprintf("http://prometheus-operated.%s.svc:9090", s.ns), "isDefault": true},
					},
				}})
			}
		}

		if local && promEnabled && s.rwHost != "" {
			add(object{key: "prometheus-remote-write", ready: seen("prometheus-remote-write"), manifest: s.remoteWriteIngress()})
		}

		access, _ := s.spec["access"].([]any)
		for i, a := range access {
			a := obj(a)
			key := fmt.Sprintf("access-%d", i)
			meta := s.meta(fmt.Sprintf("project-%s-%s", str(a["role"]), trunc(sha1hex(str(a["group"])), 8)))
			meta["annotations"] = Object{"platform.cndev.nl/group": str(a["group"])}
			add(object{key: key, ready: seen(key), manifest: Object{
				"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": meta,
				"roleRef":  Object{"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": a["role"]},
				"subjects": []any{Object{"apiGroup": "rbac.authorization.k8s.io", "kind": "Group", "name": str(a["group"])}},
			}})
		}

		// The quota is for the workloads: none on the control plane.
		if len(quota) > 0 && !local {
			hard := Object{}
			if v := str(quota["cpu"]); v != "" {
				hard["requests.cpu"] = v
			}
			if v := str(quota["memory"]); v != "" {
				hard["requests.memory"], hard["limits.memory"] = v, v
			}
			if v := str(quota["storage"]); v != "" {
				hard["requests.storage"] = v
			}
			add(object{key: "quota", ready: seen("quota"), manifest: Object{
				"apiVersion": "v1", "kind": "ResourceQuota", "metadata": s.meta("project"), "spec": Object{"hard": hard},
			}})
			// A quota on cpu/memory rejects pods without requests/limits;
			// these defaults keep operator-generated pods schedulable.
			add(object{key: "limitrange", ready: seen("limitrange"), manifest: Object{
				"apiVersion": "v1", "kind": "LimitRange", "metadata": s.meta("project-defaults"),
				"spec": Object{"limits": []any{Object{"type": "Container",
					"defaultRequest": Object{"cpu": "50m", "memory": "64Mi"},
					"default":        Object{"memory": "256Mi"}}}},
			}})
		}
	}

	// ---- backup bucket reachability: WAL archiving runs here, so it is
	// checked from here, with this location's keys, every few minutes.
	var checkState Object
	if check != nil && !local {
		add(object{key: "backup-check-s3", ready: seen("backup-check-s3"), copyFrom: fmt.Sprintf("%s/backup-s3-%s", s.ns, m.location),
			manifest: Object{"apiVersion": "v1", "kind": "Secret", "metadata": s.meta("backup-check-s3")}})
		add(object{key: "backup-check", ready: seen("backup-check"), manifest: s.backupCheckCronJob(m, check)})
		// Unknown until the first run; Checking while one runs after a failure.
		cj := obj(dig(observed["backup-check"], "status"))
		scheduled, succeeded := str(cj["lastScheduleTime"]), str(cj["lastSuccessfulTime"])
		state := "Pending"
		switch {
		case succeeded != "" && !(succeeded < scheduled):
			state = "Reachable"
		case !empty(cj["active"]) && !emptyList(cj["active"]):
			state = "Checking"
		case scheduled != "":
			state = "Unreachable"
		}
		checkState = Object{"state": state}
		if scheduled != "" {
			checkState["lastCheckTime"] = scheduled
		}
		if succeeded != "" {
			checkState["lastSuccessTime"] = succeeded
		}
	}

	var waiting []string
	if !nsReady {
		waiting = append(waiting, "namespace")
	}
	if promEnabled && !promReady {
		waiting = append(waiting, "Prometheus")
	}
	if grafEnabled && !grafReady {
		waiting = append(waiting, "Grafana")
	}
	return objects, memberStatus{location: m.location, site: m.site, waiting: waiting, backupCheck: checkState}
}

func (s *settings) prometheusSpec(m *member, prom Object, cmEnabled bool, cmNamespace string, cmLabels Object, cmExclude []any,
	omEnabled bool, omNamespace string) Object {
	spec := Object{
		"serviceAccountName": "prometheus",
		"replicas":           1,
		"retention":          or(str(prom["retention"]), "7d"),
		"resources": Object{
			"requests": Object{"cpu": or(str(dig(prom, "resources", "requests", "cpu")), "100m"),
				"memory": or(str(dig(prom, "resources", "requests", "memory")), "512Mi")},
			"limits": Object{"memory": or(str(dig(prom, "resources", "limits", "memory")), "2Gi")},
		},
		// Without fsGroup the PVC stays root-owned and Prometheus (non-root)
		// crashes on "open /prometheus/queries.active".
		"securityContext": Object{"runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 2000, "fsGroup": 2000,
			"seccompProfile": Object{"type": "RuntimeDefault"}},
		"storage": Object{"volumeClaimTemplate": Object{"spec": pvcSpec(prom)}},
	}
	if m.local() {
		// The Prometheus in the project's locations writes here.
		spec["enableRemoteWriteReceiver"] = true
		if s.gov.prices != nil {
			// The cost rules (governance.go), over every location's series.
			spec["ruleSelector"] = Object{"matchLabels": Object{"platform.cndev.nl/project": s.name}}
			spec["ruleNamespaceSelector"] = Object{"matchLabels": Object{"kubernetes.io/metadata.name": s.ns}}
		}
		return spec
	}
	// Tells this location's series apart in the shared Grafana.
	spec["externalLabels"] = Object{"location": m.location, "site": m.site}
	if s.rwURL != "" {
		spec["remoteWrite"] = []any{Object{"url": s.rwURL}}
	}
	// Every PodMonitor in this namespace (what the workloads create) and,
	// with operator metrics on, the CNPG operator's.
	spec["podMonitorSelector"] = Object{}
	if omEnabled {
		spec["podMonitorNamespaceSelector"] = Object{"matchExpressions": []any{Object{
			"key": "kubernetes.io/metadata.name", "operator": "In", "values": []any{s.ns, omNamespace}}}}
	}
	// Rules from this namespace and, with cluster metrics on,
	// kube-prometheus-stack's recording rules the dashboards' CPU panels query.
	ruleNamespaces := []any{s.ns}
	if cmEnabled {
		ruleNamespaces = append(ruleNamespaces, cmNamespace)
	}
	spec["ruleSelector"] = Object{}
	spec["ruleNamespaceSelector"] = Object{"matchExpressions": []any{Object{
		"key": "kubernetes.io/metadata.name", "operator": "In", "values": ruleNamespaces}}}
	if cmEnabled {
		// Only the node/container ServiceMonitors from kube-prometheus-stack,
		// not the control-plane ones.
		spec["serviceMonitorNamespaceSelector"] = Object{"matchLabels": Object{"kubernetes.io/metadata.name": cmNamespace}}
		labels := Object{}
		for k, v := range cmLabels {
			labels[k] = fmt.Sprint(v)
		}
		sel := Object{"matchLabels": labels}
		if len(cmExclude) > 0 {
			sel["matchExpressions"] = []any{Object{"key": "app", "operator": "NotIn", "values": cmExclude}}
		}
		spec["serviceMonitorSelector"] = sel
	}
	return spec
}

func pvcSpec(prom Object) Object {
	spec := Object{
		"accessModes": []any{"ReadWriteOnce"},
		"resources":   Object{"requests": Object{"storage": or(str(dig(prom, "storage", "size")), "10Gi")}},
	}
	if sc := str(dig(prom, "storage", "storageClass")); sc != "" {
		spec["storageClassName"] = sc
	}
	return spec
}

func (s *settings) grafana(host string, scope Object) Object {
	labels := s.labelsObj()
	for k, v := range scope {
		labels[k] = v
	}
	config := Object{
		// The portal embeds the dashboards in an iframe.
		"security": Object{"allow_embedding": "true"},
		// Read-only anonymous access so the iframe works without a login.
		// Admin login: Secret grafana-admin-credentials.
		"auth.anonymous": Object{"enabled": "true", "org_role": "Viewer"},
	}
	spec := Object{"config": config}
	if host != "" {
		config["server"] = Object{"root_url": fmt.Sprintf("%s://%s", s.scheme, host)}
		ing := Object{"rules": []any{Object{"host": host, "http": Object{"paths": []any{Object{
			"path": "/", "pathType": "Prefix",
			"backend": Object{"service": Object{"name": "grafana-service", "port": Object{"number": 3000}}},
		}}}}}}
		if c := str(s.ingress["className"]); c != "" {
			ing["ingressClassName"] = c
		}
		if t := str(s.ingress["tlsSecretName"]); t != "" {
			ing["tls"] = []any{Object{"hosts": []any{host}, "secretName": t}}
		}
		spec["ingress"] = Object{"spec": ing}
	}
	return Object{
		"apiVersion": "grafana.integreatly.org/v1beta1", "kind": "Grafana",
		"metadata": Object{"name": "grafana", "namespace": s.ns, "labels": labels},
		"spec":     spec,
	}
}

// remoteWriteIngress exposes only the remote-write path: the Prometheus in
// the locations push through it. Restrict it with ingress annotations from
// project-defaults (prometheus.remoteWrite.annotations).
func (s *settings) remoteWriteIngress() Object {
	meta := s.meta("prometheus-remote-write")
	if ann := obj(s.remoteWrite["annotations"]); len(ann) > 0 {
		a := Object{}
		for k, v := range ann {
			a[k] = fmt.Sprint(v)
		}
		meta["annotations"] = a
	}
	spec := Object{"rules": []any{Object{"host": s.rwHost, "http": Object{"paths": []any{Object{
		"path": "/api/v1/write", "pathType": "Exact",
		"backend": Object{"service": Object{"name": "prometheus-operated", "port": Object{"number": 9090}}},
	}}}}}}
	if c := str(s.remoteWrite["className"]); c != "" {
		spec["ingressClassName"] = c
	}
	if t := str(s.remoteWrite["tlsSecretName"]); t != "" {
		spec["tls"] = []any{Object{"hosts": []any{s.rwHost}, "secretName": t}}
	}
	return Object{"apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": meta, "spec": spec}
}

// backupCheckScript writes, reads back and deletes platform-check/<location>
// in the bucket: what WAL archiving (write) and a replica cluster (read)
// need. The job's log says why it failed.
const backupCheckScript = `set -u
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
`

func (s *settings) backupCheckCronJob(m *member, check *backupCheck) Object {
	env := []any{
		Object{"name": "LOCATION", "value": m.location},
		Object{"name": "S3_ENDPOINT", "value": check.endpoint},
		Object{"name": "S3_BUCKET", "value": check.bucket},
	}
	for _, k := range []string{"ACCESS_KEY_ID", "ACCESS_SECRET_KEY", "REGION"} {
		ref := Object{"name": "backup-check-s3", "key": k}
		if k == "REGION" {
			ref["optional"] = true
		}
		env = append(env, Object{"name": k, "valueFrom": Object{"secretKeyRef": ref}})
	}
	podLabels := s.labelsObj()
	podLabels["platform.cndev.nl/check"] = "backup"
	return Object{
		"apiVersion": "batch/v1", "kind": "CronJob", "metadata": s.meta("backup-check"),
		"spec": Object{
			"schedule": check.schedule, "concurrencyPolicy": "Forbid",
			"successfulJobsHistoryLimit": 1, "failedJobsHistoryLimit": 1,
			"jobTemplate": Object{"spec": Object{
				"backoffLimit": 0, "activeDeadlineSeconds": 120,
				"template": Object{
					"metadata": Object{"labels": podLabels},
					"spec": Object{
						"restartPolicy": "Never", "automountServiceAccountToken": false,
						// Numeric, so the kubelet can verify non-root for images
						// whose USER is a name (curlimages/curl runs as "curl_user").
						"securityContext": Object{"runAsNonRoot": true, "runAsUser": 65534, "runAsGroup": 65534,
							"seccompProfile": Object{"type": "RuntimeDefault"}},
						"containers": []any{Object{
							"name": "check", "image": check.image,
							"command": []any{"sh", "-c"}, "args": []any{backupCheckScript},
							"env":       env,
							"resources": Object{"requests": Object{"cpu": "10m", "memory": "16Mi"}, "limits": Object{"memory": "64Mi"}},
							"securityContext": Object{"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true,
								"capabilities": Object{"drop": []any{"ALL"}}},
							"volumeMounts": []any{Object{"name": "tmp", "mountPath": "/tmp"}},
						}},
						"volumes": []any{Object{"name": "tmp", "emptyDir": Object{"sizeLimit": "1Mi"}}},
					},
				},
			}},
		},
	}
}

// wrap puts a location's object into a provider-kubernetes Object for the
// ClusterProviderConfig named after the location.
func (s *settings) wrap(key, location string, o object) Composed {
	spec := Object{
		"providerConfigRef": Object{"kind": "ClusterProviderConfig", "name": location},
		"watch":             true,
		"forProvider":       Object{"manifest": o.manifest},
	}
	if o.orphan {
		// Never delete the namespace in another location: workloads may
		// still run there (no Delete in the management policies).
		spec["managementPolicies"] = []any{"Observe", "Create", "Update", "LateInitialize"}
	}
	if o.copyFrom != "" {
		from := strings.SplitN(o.copyFrom, "/", 2)
		// The Secret's data comes from the control plane, never through this spec.
		var refs []any
		for _, f := range []string{"data", "type"} {
			refs = append(refs, Object{"patchesFrom": Object{"apiVersion": "v1", "kind": "Secret",
				"name": from[1], "namespace": from[0], "fieldPath": f}})
		}
		spec["references"] = refs
	}
	return Composed{Ready: o.ready, Object: Object{
		"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
		"metadata": Object{"name": key, "namespace": s.ns, "labels": s.labelsObj(),
			"annotations": Object{"platform.cndev.nl/location": location}},
		"spec": spec,
	}}
}

func emptyList(v any) bool {
	l, ok := v.([]any)
	return ok && len(l) == 0
}
