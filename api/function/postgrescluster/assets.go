package postgrescluster

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"sigs.k8s.io/yaml"
)

// Vendored sources, prepared by hack/generate (`make generate`) from
// src/dashboards/cnpg-cluster.json and src/alerts/ with their placeholders
// for the namespace, cluster name and dashboard uid.
var (
	//go:embed assets/zz_generated.dashboard.json
	dashboardSource string
	//go:embed assets/zz_generated.alert-rules.yaml
	alertRulesSource string
)

// Custom exporter queries (Cluster.spec.monitoring.customQueriesConfigMap).
// wal_archive: the WAL the primary has written but not yet archived to the
// object store, i.e. what a loss of this site loses (the RPO of a failover to
// the recovery site, which replays WAL from the store). pending_bytes runs
// from the start of the oldest segment still marked .ready (else the current
// segment) to the current insert position; oldest_ready_seconds is how long
// the oldest .ready file (segment or timeline history) has waited, 0 when
// archiving keeps up. Standbys and replica clusters return no row.
//
//go:embed assets/monitoring-queries.yaml
var monitoringQueries string

// Exporter queries of the vector profile. vector_index: size of every vector
// (pgvector hnsw/ivfflat, VectorChord vchordrq/vchordg) and BM25 (pg_search)
// index in every database, to compare with the memory they should fit in.
// create_index_progress: how far index builds are, which take long for vector
// indexes (pg_stat_progress_create_index, primary only).
//
//go:embed assets/vector-queries.yaml
var vectorQueries string

// queriesFor are the custom exporter queries of a cluster with this profile.
func queriesFor(profile string) string {
	q := strings.TrimSuffix(monitoringQueries, "\n")
	if profile == ProfileVector {
		q += "\n" + strings.TrimSuffix(vectorQueries, "\n")
	}
	return q
}

// Placeholders in the generated assets.
const (
	placeholderCluster   = "zzclusterzz"
	placeholderNamespace = "zznamespacezz"
	placeholderUID       = "zzuidzz"
)

func substitute(text, namespace, name, uid string) string {
	return strings.NewReplacer(placeholderCluster, name, placeholderNamespace, namespace, placeholderUID, uid).Replace(text)
}

func dashboardJSON(namespace, name, uid string) string {
	return substitute(dashboardSource, namespace, name, uid)
}

// alertRules are the CNPG alerts scoped to one cluster, without the excluded ones.
func alertRules(namespace, name string, exclude []string) ([]any, error) {
	var rules []any
	if err := yaml.Unmarshal([]byte(substitute(alertRulesSource, namespace, name, "")), &rules); err != nil {
		return nil, fmt.Errorf("embedded alert rules: %w", err)
	}
	out := rules[:0]
	for _, r := range rules {
		if alert, _ := dig(r, "alert").(string); !slices.Contains(exclude, alert) {
			out = append(out, r)
		}
	}
	return out, nil
}

// toObject converts a manifest struct to unstructured JSON.
func toObject(v any) Object {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("marshal %T: %v", v, err)) // manifest structs always marshal
	}
	var o Object
	if err := json.Unmarshal(raw, &o); err != nil {
		panic(fmt.Sprintf("unmarshal %T: %v", v, err))
	}
	return o
}
