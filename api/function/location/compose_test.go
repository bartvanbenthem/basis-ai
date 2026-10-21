package location

import "testing"

func TestCompose(t *testing.T) {
	x := Object{"metadata": Object{"name": "dc-a"},
		"spec": Object{"credentials": Object{"secretRef": Object{"namespace": "basis-locations", "name": "dc-a"}}}}
	synced := Object{"status": Object{"conditions": []any{
		Object{"type": "Synced", "status": "True"}, Object{"type": "Ready", "status": "True"}}}}
	installed := Object{"status": Object{"atProvider": Object{"manifest": Object{"kind": "APIService"}}}}

	t.Run("connected without CloudNativePG isn't ready, optional operators don't matter", func(t *testing.T) {
		out := Compose(Input{XR: x, Observed: map[string]Object{
			"providerconfig": {}, "prometheus-role": synced, "prometheus-operator": installed}})
		if out.Status.Ready || !out.Status.Connected || out.Condition.Reason != "OperatorsMissing" {
			t.Errorf("status %+v condition %+v", out.Status, out.Condition)
		}
		if want := "Connected; CloudNativePG not installed (install it there, see deps/README.md)"; out.Status.Message != want {
			t.Errorf("message %q", out.Status.Message)
		}
		if !out.Composed["valkey"].Ready || out.Composed["cnpg"].Ready {
			t.Error("optional operators must be ready, CloudNativePG not")
		}
		if ref := dig(out.Composed["providerconfig"].Object, "spec", "credentials", "secretRef", "key"); ref != "kubeconfig" {
			t.Errorf("default key %v", ref)
		}
	})

	t.Run("unreachable", func(t *testing.T) {
		failing := Object{"status": Object{"conditions": []any{
			Object{"type": "Synced", "status": "False", "message": "connection refused"}}}}
		out := Compose(Input{XR: x, Observed: map[string]Object{"providerconfig": {}, "prometheus-role": failing}})
		if out.Status.Message != "Can't reach the cluster: connection refused" || out.Status.Operators != nil {
			t.Errorf("status %+v", out.Status)
		}
	})
}
