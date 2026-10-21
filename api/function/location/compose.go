// Package location composes a Location (platform.cndev.nl/v1alpha1): a
// Kubernetes cluster the platform places workloads in.
//
// For Location <name>:
//
//	providerconfig       ClusterProviderConfig <name> (provider-kubernetes),
//	                     credentials from spec.credentials.secretRef; what the
//	                     Project and workload compositions place objects through
//	prometheus-role      Object <name>-prometheus-role: ClusterRole
//	                     basis:project-prometheus in the location (as
//	                     ../../install/project-prometheus-role.yaml), which
//	                     every Project's Prometheus there binds to. Never deleted
//	                     by Crossplane: removing the Location leaves it
//	cnpg,                observe-only Objects for the APIServices
//	prometheus-operator, v1.postgresql.cnpg.io, v1.monitoring.coreos.com,
//	valkey, agent-router v1alpha1.valkey.io and v1beta1.aigateway.envoyproxy.io,
//	                     which the API server registers for every CRD group:
//	                     small, unlike the CRDs, whose schemas would land in the
//	                     Object's status. The Valkey operator and Agent Router
//	                     are optional and never make a Location unready
//
// The Objects live in the namespace of the kubeconfig Secret. Whether the
// role Object syncs says whether Crossplane reaches the cluster
// (status.connected); the observe-only Objects say which operators are
// installed.
package location

import (
	"fmt"
	"strings"
)

type Object = map[string]any

type Input struct {
	XR       Object
	Observed map[string]Object
}

type Composed struct {
	Object Object
	Ready  bool
}

type Condition struct {
	Status  bool
	Reason  string
	Message string
}

type Operators struct {
	CloudNativePG      bool `json:"cloudnativepg"`
	PrometheusOperator bool `json:"prometheusOperator"`
	Valkey             bool `json:"valkey"`
	AgentRouter        bool `json:"agentRouter"`
}

type Status struct {
	Ready          bool       `json:"ready"`
	Message        string     `json:"message"`
	Connected      bool       `json:"connected"`
	ProviderConfig string     `json:"providerConfig,omitempty"`
	Operators      *Operators `json:"operators,omitempty"`
}

type Output struct {
	Composed  map[string]Composed
	Status    Status
	Condition Condition
}

// operator is an APIService that tells an operator is installed.
type operator struct {
	key, apiService string
	optional        bool
}

var operators = []operator{
	{"cnpg", "v1.postgresql.cnpg.io", false},
	{"prometheus-operator", "v1.monitoring.coreos.com", false},
	{"valkey", "v1alpha1.valkey.io", true},
	{"agent-router", "v1beta1.aigateway.envoyproxy.io", true},
}

// Compose renders the desired state of a Location.
func Compose(in Input) *Output {
	xr := in.XR
	name, _ := dig(xr, "metadata", "name").(string)
	ref, _ := dig(xr, "spec", "credentials", "secretRef").(Object)
	ns, _ := ref["namespace"].(string)
	labels := map[string]string{
		"app.kubernetes.io/managed-by": "crossplane",
		"app.kubernetes.io/part-of":    "basis",
		"platform.cndev.nl/location":   name,
	}
	out := &Output{Composed: map[string]Composed{}}

	pc := in.Observed["providerconfig"]
	role := in.Observed["prometheus-role"]
	synced := condition(role, "Synced")
	roleReady := conditionTrue(role, "Ready")
	connected := synced != nil && synced["status"] == "True" && roleReady
	installed := map[string]bool{}
	for _, o := range operators {
		m, _ := dig(in.Observed[o.key], "status", "atProvider", "manifest").(Object)
		installed[o.key] = len(m) > 0
	}

	out.Composed["providerconfig"] = Composed{Ready: pc != nil, Object: Object{
		"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "ClusterProviderConfig",
		"metadata": Object{"name": name, "labels": copyLabels(labels)},
		"spec": Object{"credentials": Object{"source": "Secret", "secretRef": Object{
			"namespace": ns, "name": ref["name"], "key": or(str(ref["key"]), "kubeconfig")}}},
	}}
	providerConfigRef := Object{"kind": "ClusterProviderConfig", "name": name}
	out.Composed["prometheus-role"] = Composed{Ready: roleReady, Object: Object{
		"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
		"metadata": Object{"name": name + "-prometheus-role", "namespace": ns, "labels": copyLabels(labels)},
		"spec": Object{
			"providerConfigRef": providerConfigRef,
			// Projects' Prometheus ClusterRoleBindings there point at it:
			// leave it when the Location goes (no Delete), which also lets
			// the Location be removed while the cluster is unreachable.
			"managementPolicies": []any{"Observe", "Create", "Update", "LateInitialize"},
			"forProvider": Object{"manifest": Object{
				"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole",
				"metadata": Object{"name": "basis:project-prometheus", "labels": Object{
					"app.kubernetes.io/managed-by": "crossplane", "app.kubernetes.io/part-of": "basis"}},
				"rules": []any{
					Object{"apiGroups": []any{""}, "resources": []any{"nodes", "nodes/metrics", "nodes/proxy", "services", "endpoints", "pods"},
						"verbs": []any{"get", "list", "watch"}},
					Object{"apiGroups": []any{"discovery.k8s.io"}, "resources": []any{"endpointslices"},
						"verbs": []any{"get", "list", "watch"}},
					Object{"nonResourceURLs": []any{"/metrics", "/metrics/cadvisor"}, "verbs": []any{"get"}},
				},
			}},
		},
	}}
	for _, o := range operators {
		out.Composed[o.key] = Composed{Ready: installed[o.key] || o.optional, Object: Object{
			"apiVersion": "kubernetes.m.crossplane.io/v1alpha1", "kind": "Object",
			"metadata": Object{"name": name + "-" + o.key, "namespace": ns, "labels": copyLabels(labels)},
			"spec": Object{
				"providerConfigRef":  providerConfigRef,
				"managementPolicies": []any{"Observe"},
				"forProvider": Object{"manifest": Object{
					"apiVersion": "apiregistration.k8s.io/v1", "kind": "APIService",
					"metadata": Object{"name": o.apiService}}},
			},
		}}
	}

	var missing []string
	if !installed["cnpg"] {
		missing = append(missing, "CloudNativePG")
	}
	if !installed["prometheus-operator"] {
		missing = append(missing, "the Prometheus Operator CRDs")
	}
	ready := connected && len(missing) == 0
	msg := fmt.Sprintf("Location %s is ready", name)
	switch {
	case pc == nil:
		msg = "Creating the ClusterProviderConfig"
	case role == nil:
		msg = "Connecting"
	case !connected:
		msg = "Can't reach the cluster: " + or(str(synced["message"]), "waiting for provider-kubernetes")
	case len(missing) > 0:
		msg = fmt.Sprintf("Connected; %s not installed (install it there, see deps/README.md)", strings.Join(missing, " and "))
	}
	out.Status = Status{Ready: ready, Message: msg, Connected: connected}
	if pc != nil {
		out.Status.ProviderConfig = name
	}
	if connected {
		out.Status.Operators = &Operators{
			CloudNativePG: installed["cnpg"], PrometheusOperator: installed["prometheus-operator"],
			Valkey: installed["valkey"], AgentRouter: installed["agent-router"],
		}
	}
	reason := "Connecting"
	switch {
	case ready:
		reason = "Available"
	case connected:
		reason = "OperatorsMissing"
	}
	out.Condition = Condition{Status: ready, Reason: reason, Message: msg}
	return out
}

func copyLabels(l map[string]string) Object {
	out := Object{}
	for k, v := range l {
		out[k] = v
	}
	return out
}

func dig(obj any, path ...string) any {
	for _, p := range path {
		m, ok := obj.(map[string]any)
		if !ok {
			return nil
		}
		if obj, ok = m[p]; !ok {
			return nil
		}
	}
	return obj
}

func condition(obj Object, t string) map[string]any {
	conds, _ := dig(obj, "status", "conditions").([]any)
	for _, c := range conds {
		if m, ok := c.(map[string]any); ok && m["type"] == t {
			return m
		}
	}
	return nil
}

func conditionTrue(obj Object, t string) bool {
	c := condition(obj, t)
	return c != nil && c["status"] == "True"
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func or(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
