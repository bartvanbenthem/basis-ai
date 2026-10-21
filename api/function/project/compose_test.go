package project

import (
	"encoding/json"
	"testing"
)

func xr(t *testing.T, name, spec, status string) Object {
	t.Helper()
	var o Object
	if err := json.Unmarshal([]byte(`{"apiVersion":"platform.cndev.nl/v1alpha1","kind":"Project",
		"metadata":{"name":"`+name+`"},"spec":`+spec+`,"status":`+status+`}`), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

var cosiDefaults = map[string][]Object{requiredDefaults: {{"data": Object{"backup": Object{"cosi": Object{
	"driverName": "cosi.example.com", "bucketAccessClassName": "s3-keys"}}}}}}

func TestRequirements(t *testing.T) {
	x := xr(t, "demo", `{"locations":{"protected":"dc-a","recovery":"dc-b"}}`, `{}`)

	// First round: project-defaults isn't resolved yet, so no bucket.
	first := Requirements(x, nil)
	for _, k := range []string{"defaults", "location-dc-a", "location-dc-b"} {
		if _, ok := first[k]; !ok {
			t.Errorf("first round misses %s: %v", k, first)
		}
	}
	if _, ok := first["cosi-dc-a"]; ok {
		t.Errorf("first round asks for COSI secrets without project-defaults")
	}

	// Second round: with COSI classes the bucket's Secrets and stores follow.
	second := Requirements(x, cosiDefaults)
	if r := second["cosi-dc-b"]; r.Namespace != "demo" || r.Name != "cosi-backups-dc-b" {
		t.Errorf("cosi-dc-b = %+v", r)
	}
	if r := second[requiredBackupStores]; r.Labels["postgres.cndev.nl/backup-store"] != "true" || r.Name != "" {
		t.Errorf("backup-stores = %+v", r)
	}
}

func TestBucketClassName(t *testing.T) {
	for name, want := range map[string]string{
		"payments":                 "project-payments-backups",
		"a-very-long-project-name": "prj-a-very-long-proj-" + trunc(sha256hex("a-very-long-project-name"), 6),
		// The 16-character cut ends on "-": dropped.
		"abcdefghijklmno-pqrs": "prj-abcdefghijklmno-" + trunc(sha256hex("abcdefghijklmno-pqrs"), 6),
	} {
		s := newSettings(xr(t, name, `{"locations":{"protected":"dc-a"}}`, `{}`), cosiDefaults)
		if s.bucketClass != want || len(s.bucketClass) > 27 {
			t.Errorf("%s: bucket class %q, want %q", name, s.bucketClass, want)
		}
	}
}

func TestInventoryKeepsWhatAStoreNoLongerSays(t *testing.T) {
	s := newSettings(xr(t, "demo", `{"locations":{"protected":"dc-a"}}`,
		`{"backup":{"servers":[
			{"serverName":"orders-db","active":true,"database":"orders","postgresVersion":17,"firstRecoverabilityPoint":"t0"},
			{"serverName":"gone-db","active":true,"database":"old"}]}}`), cosiDefaults)
	store := Object{
		"metadata": Object{"labels": Object{"postgres.cndev.nl/postgrescluster": "orders-db"},
			"annotations": Object{"platform.cndev.nl/location": "dc-a"}},
		"status": Object{"atProvider": Object{"manifest": Object{
			"metadata": Object{"annotations": Object{"postgres.cndev.nl/server-name": "orders-db",
				"postgres.cndev.nl/postgres-version": "18"}},
			"spec":   Object{"configuration": Object{"destinationPath": "s3://bkt/barman"}},
			"status": Object{"serverRecoveryWindow": Object{"orders-db": Object{"lastSuccessfulBackupTime": "t1"}}},
		}}},
	}
	servers := s.inventory(Object{"bucket": "bkt"}, []Object{store})

	orders := servers["orders-db"]
	if orders["active"] != true || orders["postgresVersion"] != 18 || orders["cluster"] != "orders-db" {
		t.Errorf("orders-db = %v", orders)
	}
	// Not in the store's annotations any more: the last status's value stays.
	if orders["database"] != "orders" || orders["firstRecoverabilityPoint"] != "t0" || orders["lastSuccessfulBackup"] != "t1" {
		t.Errorf("orders-db lost what it had: %v", orders)
	}
	if gone := servers["gone-db"]; gone["active"] != false || gone["database"] != "old" {
		t.Errorf("gone-db = %v", gone)
	}
}

func TestLocationsWaitForTheHubNamespace(t *testing.T) {
	out := Compose(Input{XR: xr(t, "demo", `{"locations":{"protected":"dc-a"}}`, `{}`),
		Required: map[string][]Object{"location-dc-a": {{"spec": Object{}}}}})
	if _, ok := out.Composed["location-dc-a-namespace"]; ok {
		t.Error("objects in dc-a before the project namespace exists on the control plane")
	}
	if _, ok := out.Composed["usage-location-dc-a"]; !ok {
		t.Error("no ClusterUsage for the registered location")
	}
	if out.Condition.Status || out.Status["message"] != "Waiting for namespace, Prometheus, Grafana, the project namespace on the control plane in dc-a" {
		t.Errorf("message %q", out.Status["message"])
	}
}
