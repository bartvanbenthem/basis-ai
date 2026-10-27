package postgrescluster

import (
	"encoding/json"
	"strings"
)

// Object is a Kubernetes object as unstructured JSON.
type Object = map[string]any

// live normalises the observed composed resources: a provider-kubernetes
// Object stands for the object it manages in its location (its
// status.atProvider.manifest), so the members read live CNPG status as if the
// objects were local. An Object whose manifest isn't reported yet is left out.
func live(observed map[string]Object) map[string]Object {
	out := make(map[string]Object, len(observed))
	for name, obj := range observed {
		kind, _ := obj["kind"].(string)
		apiVersion, _ := obj["apiVersion"].(string)
		if kind == "Object" && strings.HasPrefix(apiVersion, "kubernetes.m.crossplane.io/") {
			if m, _ := dig(obj, "status", "atProvider", "manifest").(Object); len(m) > 0 {
				out[name] = m
			}
			continue
		}
		out[name] = obj
	}
	return out
}

// dig returns the value at path, or nil.
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

// decode reads the JSON-shaped v into a typed value. Fields of an unexpected
// type are skipped (json.Unmarshal fills in the rest), so a status field
// CNPG changes in a later version never blocks a reconcile.
func decode(v any, into any) {
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = json.Unmarshal(raw, into) //nolint:errcheck // best effort, see above
}

// clusterStatus is what the composition reads from a CNPG Cluster's status.
type clusterStatus struct {
	Phase          string `json:"phase"`
	Instances      int    `json:"instances"`
	ReadyInstances int    `json:"readyInstances"`
	CurrentPrimary string `json:"currentPrimary"`
	Image          string `json:"image"`
	Conditions     []struct {
		Type   string `json:"type"`
		Status string `json:"status"`
	} `json:"conditions"`
	// Published by a demoted primary; promotes the replica cluster that
	// sets it as replica.promotionToken (switchover).
	DemotionToken string `json:"demotionToken"`
	// The token this cluster was last promoted with.
	LastPromotionToken string `json:"lastPromotionToken"`
}

func (s *clusterStatus) ready() bool {
	for _, c := range s.Conditions {
		if c.Type == "Ready" && c.Status == "True" {
			return true
		}
	}
	return false
}

func readClusterStatus(cluster Object) clusterStatus {
	var s clusterStatus
	decode(cluster["status"], &s)
	return s
}

// recoveryWindow is one server's entry in a Barman Cloud ObjectStore's
// status.serverRecoveryWindow.
type recoveryWindow struct {
	FirstRecoverabilityPoint string `json:"firstRecoverabilityPoint"`
	LastSuccessfulBackupTime string `json:"lastSuccessfulBackupTime"`
}

func readRecoveryWindow(objectStore Object, server string) recoveryWindow {
	var w recoveryWindow
	decode(dig(objectStore, "status", "serverRecoveryWindow", server), &w)
	return w
}

// databaseApplied reports whether CNPG has applied a Database.
func databaseApplied(db Object) bool {
	applied, _ := dig(db, "status", "applied").(bool)
	return applied
}
