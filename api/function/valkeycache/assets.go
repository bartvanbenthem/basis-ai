package valkeycache

import (
	_ "embed"
	"fmt"
	"slices"
	"strings"

	"sigs.k8s.io/yaml"
)

// Vendored sources, prepared by hack/generate (`make generate`) from
// monitoring/dashboards/valkey-cache.json and monitoring/alerts/valkey-cache-rules.yaml with
// their placeholders for the namespace, cache name and dashboard uid.
var (
	//go:embed assets/zz_generated.dashboard.json
	dashboardSource string
	//go:embed assets/zz_generated.alert-rules.yaml
	alertRulesSource string
)

// Placeholders in the generated assets (the same as postgrescluster's).
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

// alertRules are the cache alerts scoped to one cache, without the excluded ones.
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
