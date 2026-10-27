// Command alertrules writes monitoring/alerts/cnpg-cluster-rules.yaml from the
// PrometheusRule the upstream cnpg/cluster Helm chart renders; see
// hack/refresh-alerts.sh.
//
//	go run ./hack/alertrules <prometheus-rule.yaml> <out.yaml> <chart-version>
package main

import (
	"bytes"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: alertrules <prometheus-rule.yaml> <out.yaml> <chart-version>")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(src, out, version string) error {
	raw, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("%s: %w", src, err)
	}
	rules := lookup(&doc, "spec", "groups", 0, "rules")
	if rules == nil || rules.Kind != yaml.SequenceNode {
		return fmt.Errorf("%s: no spec.groups[0].rules", src)
	}
	for _, rule := range rules.Content {
		// Helm-specific labels that would only confuse alert routing.
		labels := lookup(rule, "labels")
		if labels == nil || labels.Kind != yaml.MappingNode {
			continue
		}
		kept := labels.Content[:0]
		for i := 0; i+1 < len(labels.Content); i += 2 {
			k := labels.Content[i].Value
			if strings.HasPrefix(k, "app.kubernetes.io/") || strings.HasPrefix(k, "helm.sh/") {
				continue
			}
			kept = append(kept, labels.Content[i], labels.Content[i+1])
		}
		labels.Content = kept
	}

	literalBlocks(rules)

	var body bytes.Buffer
	enc := yaml.NewEncoder(&body)
	enc.SetIndent(2)
	if err := enc.Encode(rules); err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	header := fmt.Sprintf(`# CloudNativePG alert rules, rendered from the upstream cnpg/cluster Helm
# chart %s (Apache-2.0, https://github.com/cloudnative-pg/charts) by
# hack/refresh-alerts.sh -- do not edit by hand; change a rule by adding its
# replacement to local-rules.yaml. function-basis substitutes, per cluster:
#   zzclusterzz   -> the PostgresCluster name
#   zznamespacezz -> the PostgresCluster namespace
`, version)
	if err := os.WriteFile(out, append([]byte(header), body.Bytes()...), 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %d rules from cnpg/cluster %s to %s\n", len(rules.Content), version, out)
	return nil
}

// literalBlocks writes multi-line strings (alert descriptions, PromQL) as
// readable `|` blocks instead of folded quoted scalars.
func literalBlocks(n *yaml.Node) {
	if n.Kind == yaml.ScalarNode && n.Tag == "!!str" && strings.Contains(n.Value, "\n") {
		n.Style = yaml.LiteralStyle
	}
	for _, c := range n.Content {
		literalBlocks(c)
	}
}

// lookup follows mapping keys (string) and sequence indexes (int) in a node tree.
func lookup(n *yaml.Node, path ...any) *yaml.Node {
	if n != nil && n.Kind == yaml.DocumentNode && len(n.Content) == 1 {
		n = n.Content[0]
	}
	for _, p := range path {
		if n == nil {
			return nil
		}
		switch k := p.(type) {
		case string:
			if n.Kind != yaml.MappingNode {
				return nil
			}
			var next *yaml.Node
			for i := 0; i+1 < len(n.Content); i += 2 {
				if n.Content[i].Value == k {
					next = n.Content[i+1]
					break
				}
			}
			n = next
		case int:
			if n.Kind != yaml.SequenceNode || k >= len(n.Content) {
				return nil
			}
			n = n.Content[k]
		}
	}
	return n
}
