package main

import (
	"context"
	"testing"

	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/resource"
)

func runFunction(t *testing.T, req *fnv1.RunFunctionRequest) *fnv1.RunFunctionResponse {
	t.Helper()
	rsp, err := (&Function{log: logging.NewNopLogger()}).RunFunction(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	return rsp
}

func TestRunFunction(t *testing.T) {
	xr := resource.MustStructJSON(`{"apiVersion":"postgres.cndev.nl/v1alpha1","kind":"PostgresCluster",
		"metadata":{"name":"orders-db","namespace":"payments"},"spec":{}}`)
	project := resource.MustStructJSON(`{"apiVersion":"platform.cndev.nl/v1alpha1","kind":"Project",
		"metadata":{"name":"payments"},"spec":{"locations":{"protected":"si-ske-demo"}}}`)

	t.Run("asks for the Project and the catalogs", func(t *testing.T) {
		rsp := runFunction(t, &fnv1.RunFunctionRequest{Observed: &fnv1.State{Composite: &fnv1.Resource{Resource: xr}}})
		sel := rsp.GetRequirements().GetResources()
		if sel["project"].GetMatchName() != "payments" || sel["sizes"].GetMatchName() != "postgres-sizes" ||
			sel["extensions"].GetMatchName() != "postgres-extensions" {
			t.Errorf("requirements %v", sel)
		}
	})

	t.Run("composes once the Project is there", func(t *testing.T) {
		rsp := runFunction(t, &fnv1.RunFunctionRequest{
			Observed:          &fnv1.State{Composite: &fnv1.Resource{Resource: xr}},
			RequiredResources: map[string]*fnv1.Resources{"project": {Items: []*fnv1.Resource{{Resource: project}}}},
		})
		if len(rsp.GetResults()) > 0 {
			t.Fatalf("results %v", rsp.GetResults())
		}
		cluster := rsp.GetDesired().GetResources()["cluster"]
		if cluster.GetReady() != fnv1.Ready_READY_FALSE {
			t.Errorf("cluster ready %v, want false (not observed yet)", cluster.GetReady())
		}
		pc := cluster.GetResource().GetFields()["spec"].GetStructValue().GetFields()["providerConfigRef"].GetStructValue()
		if pc.GetFields()["name"].GetStringValue() != "si-ske-demo" {
			t.Errorf("providerConfigRef %v", pc)
		}
		status := rsp.GetDesired().GetComposite().GetResource().GetFields()["status"].GetStructValue().GetFields()
		if status["primaryLocation"].GetStringValue() != "si-ske-demo" {
			t.Errorf("status %v", status)
		}
		if c := rsp.GetConditions(); len(c) != 1 || c[0].GetType() != "PostgresReady" || c[0].GetReason() != "ClusterNotReady" {
			t.Errorf("conditions %v", c)
		}
	})

	t.Run("composes a ValkeyCache", func(t *testing.T) {
		cache := resource.MustStructJSON(`{"apiVersion":"cache.cndev.nl/v1alpha1","kind":"ValkeyCache",
			"metadata":{"name":"llm-cache","namespace":"payments"},"spec":{"mode":"semantic"}}`)
		rsp := runFunction(t, &fnv1.RunFunctionRequest{
			Observed:          &fnv1.State{Composite: &fnv1.Resource{Resource: cache}},
			RequiredResources: map[string]*fnv1.Resources{"project": {Items: []*fnv1.Resource{{Resource: project}}}},
		})
		if len(rsp.GetResults()) > 0 {
			t.Fatalf("results %v", rsp.GetResults())
		}
		if rsp.GetRequirements().GetResources()["project"].GetMatchName() != "payments" {
			t.Errorf("requirements %v", rsp.GetRequirements())
		}
		res := rsp.GetDesired().GetResources()
		for _, key := range []string{"auth-secret", "cluster", "dashboard"} {
			if res[key] == nil {
				t.Errorf("missing %s", key)
			}
		}
		status := rsp.GetDesired().GetComposite().GetResource().GetFields()["status"].GetStructValue().GetFields()
		if status["location"].GetStringValue() != "si-ske-demo" || status["monitoring"].GetStructValue() == nil {
			t.Errorf("status %v", status)
		}
		if c := rsp.GetConditions(); len(c) != 1 || c[0].GetType() != "CacheReady" {
			t.Errorf("conditions %v", c)
		}
	})

	t.Run("refuses other kinds", func(t *testing.T) {
		other := resource.MustStructJSON(`{"apiVersion":"example.org/v1","kind":"Other","metadata":{"name":"x"}}`)
		rsp := runFunction(t, &fnv1.RunFunctionRequest{Observed: &fnv1.State{Composite: &fnv1.Resource{Resource: other}}})
		if r := rsp.GetResults(); len(r) != 1 || r[0].GetSeverity() != fnv1.Severity_SEVERITY_FATAL {
			t.Errorf("results %v", r)
		}
	})
}
