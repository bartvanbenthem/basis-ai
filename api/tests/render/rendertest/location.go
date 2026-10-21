package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/bartvanbenthem/basis-ai/api/internal/doc"
)

func assertLocation(r *render) {
	kase, state, status, name, composed := r.kase, r.state, r.status, r.name, r.composed
	check := r.check
	ref := mp(r.xr, "spec", "credentials", "secretRef")

	check(sameKeys(composed, set("providerconfig", "prometheus-role", "cnpg", "prometheus-operator", "valkey", "agent-router")),
		"composed resources %v", r.keys())

	// --- the ClusterProviderConfig the Project/PostgresCluster compositions use
	pc := composed["providerconfig"]
	check(str(pc, "kind") == "ClusterProviderConfig" && str(pc, "metadata", "name") == name,
		"ClusterProviderConfig must be named after the location")
	key := "kubeconfig"
	if has(ref, "key") {
		key = str(ref, "key")
	}
	check(equal(get(pc, "spec", "credentials"), M{"source": "Secret", "secretRef": M{
		"namespace": get(ref, "namespace"), "name": get(ref, "name"), "key": key}}),
		"credentials %s", repr(get(pc, "spec", "credentials")))

	// --- Objects in the location
	for _, k := range []string{"prometheus-role", "cnpg", "prometheus-operator", "valkey", "agent-router"} {
		obj := composed[k]
		check(str(obj, "kind") == "Object", "%s: must be an Object", k)
		check(equal(get(obj, "metadata", "namespace"), get(ref, "namespace")), "%s: not next to the kubeconfig Secret", k)
		check(strings.HasPrefix(str(obj, "metadata", "name"), name+"-"), "%s: name not prefixed with the location", k)
		check(equal(get(obj, "spec", "providerConfigRef"), M{"kind": "ClusterProviderConfig", "name": name}),
			"%s: providerConfigRef", k)
	}
	role := composed["prometheus-role"]
	policies := strs(get(role, "spec", "managementPolicies"))
	deletes := false
	for _, p := range policies {
		deletes = deletes || p == "Delete"
	}
	check(!deletes, "the Prometheus ClusterRole must outlive the Location (projects' bindings there use it)")
	check(str(role, "spec", "forProvider", "manifest", "metadata", "name") == "basis:project-prometheus",
		"the ClusterRole name must match what the Project composition binds")
	installed, err := doc.Load(filepath.Join(root(), "install", "project-prometheus-role.yaml"))
	check(err == nil && equal(get(role, "spec", "forProvider", "manifest", "rules"), get(installed, "rules")),
		"ClusterRole rules differ from install/project-prometheus-role.yaml")
	for _, pair := range [][2]string{{"cnpg", "v1.postgresql.cnpg.io"}, {"prometheus-operator", "v1.monitoring.coreos.com"},
		{"valkey", "v1alpha1.valkey.io"}, {"agent-router", "v1beta1.aigateway.envoyproxy.io"}} {
		obj := composed[pair[0]]
		check(equal(get(obj, "spec", "managementPolicies"), L{"Observe"}), "%s: must only observe", pair[0])
		check(str(obj, "spec", "forProvider", "manifest", "metadata", "name") == pair[1], "%s: APIService", pair[0])
	}

	// --- status
	creating := M{"ready": false, "connected": false, "providerConfig": nil, "operators": nil,
		"message": "Creating the ClusterProviderConfig"}
	expected, ok := map[string]M{
		"minimal/empty":     creating,
		"unreachable/empty": creating,
		"ready/empty":       creating,
		"minimal/observed": {"ready": false, "connected": true, "providerConfig": name,
			"operators": M{"cloudnativepg": true, "prometheusOperator": false, "valkey": false, "agentRouter": false},
			"message":   "Connected; the Prometheus Operator CRDs not installed (install it there, see deps/README.md)"},
		"ready/observed": {"ready": true, "connected": true, "providerConfig": name,
			"operators": M{"cloudnativepg": true, "prometheusOperator": true, "valkey": false, "agentRouter": false},
			"message":   fmt.Sprintf("Location %s is ready", name)},
		"unreachable/observed": {"ready": false, "connected": false, "providerConfig": name, "operators": nil,
			"message": "Can't reach the cluster: connect failed: dial tcp 10.0.0.9:6443: i/o timeout"},
	}[kase+"/"+state]
	if !ok {
		check(false, "no expectations for case %s/%s", kase, state)
	}
	for _, k := range doc.Keys(expected) {
		check(equal(get(status, k), expected[k]), "status.%s = %s, want %s", k, repr(get(status, k)), repr(expected[k]))
	}

	// function-basis marks the composed resources ready, which makes the XR Ready;
	// ready/observed has no Valkey operator and is Ready all the same (it's optional).
	want := "False"
	if equal(get(status, "ready"), true) {
		want = "True"
	}
	check(str(r.conds["Ready"], "status") == want, "XR Ready %s, want %s", repr(r.conds["Ready"]), want)
	check(str(r.conds["LocationReady"], "status") == want, "LocationReady %s", repr(r.conds["LocationReady"]))
}
