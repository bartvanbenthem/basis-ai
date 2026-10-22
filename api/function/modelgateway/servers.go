package modelgateway

// Self-hosted models: a spec.models entry with a server instead of an
// endpoint names a ModelServer in the namespace (../modelserver), vLLM on
// KServe in the same Project sites as the gateway.
//
// Where it can, the model's route rule hands requests to the server's
// InferencePool: llm-d's endpoint picker then chooses the replica most likely
// to have the prompt's prefix cached. Agent Router can't rename the model for
// a pool, nor combine one with other backends in a rule, so a model goes to
// the server's Service instead (an OpenAI backend, round robin) when:
//
//   - the server serves it under another name (spec.model.name)
//   - it has fallbacks, or is another model's fallback
//   - the server has prefix-cache-aware routing off
//
// In a site the server doesn't run in, the model isn't routed.

import (
	"fmt"

	"github.com/bartvanbenthem/basis-ai/api/function/modelserver"
)

// RequiredServer is the requirement name of ModelServer name.
func RequiredServer(name string) string { return "server-" + name }

// Requirements: the Project (its sites) and the ModelServers spec.models names.
func Requirements(xr Object) map[string]Requirement {
	var x XR
	decode(xr, &x)
	ns := x.Metadata.Namespace
	out := map[string]Requirement{RequiredProject: {"platform.cndev.nl/v1alpha1", "Project", "", ns}}
	for _, m := range x.Spec.Models {
		if m.Server != "" {
			out[RequiredServer(m.Server)] = Requirement{"ai.cndev.nl/v1alpha1", "ModelServer", ns, m.Server}
		}
	}
	return out
}

// server is what the gateway knows of a ModelServer.
type server struct {
	// resolved: Crossplane looked it up; found: it exists.
	resolved, found bool
	served          string
	pool            bool
	recovery        bool
}

func (s server) runsIn(site string) bool { return !s.found || site == SiteProtected || s.recovery }

// servers are the ModelServers spec.models names, as far as they're resolved.
func (c *composition) resolveServers(required map[string][]Object) {
	c.servers = map[string]server{}
	for _, m := range c.spec.Models {
		if m.Server == "" {
			continue
		}
		items, resolved := required[RequiredServer(m.Server)]
		s := server{resolved: resolved, served: m.Name, pool: true}
		if len(items) > 0 {
			obj := items[0]
			s.found, s.served = true, modelserver.ServedName(obj)
			if v, ok := dig(obj, "spec", "routing", "prefixCacheAware").(bool); ok {
				s.pool = v
			}
			s.recovery, _ = dig(obj, "spec", "recovery", "enabled").(bool)
		}
		c.servers[m.Server] = s
	}
}

// route is how a site's gateway reaches one of spec.models.
type route struct {
	Model
	// pool is a self-hosted model's InferencePool, instead of a backend.
	pool string
}

// routes are the models a site's gateway serves, sorted by name (the order
// of the route's rules), self-hosted ones resolved to their server's
// InferencePool or Service.
func (c *composition) routes(site string) []route {
	fallback := map[string]bool{}
	for _, m := range c.spec.Models {
		for _, f := range c.spec.fallbacks(m) {
			fallback[f] = true
		}
	}
	var out []route
	for _, m := range sortedModels(c.spec.Models) {
		if m.Server == "" {
			out = append(out, route{Model: m})
			continue
		}
		s := c.servers[m.Server]
		if !s.runsIn(site) {
			continue
		}
		if s.pool && s.served == m.Name && len(c.spec.fallbacks(m)) == 0 && !fallback[m.Name] {
			out = append(out, route{Model: m, pool: modelserver.InferencePool(m.Server)})
			continue
		}
		r := route{Model: m}
		r.Endpoint, r.Schema, r.APIKeySecretRef = modelserver.Endpoint(m.Server, c.ns), "OpenAI", nil
		r.UpstreamModel = ""
		if s.served != m.Name {
			r.UpstreamModel = s.served
		}
		out = append(out, r)
	}
	return out
}

// serverNotes are what keeps self-hosted models from serving: a ModelServer
// that doesn't exist, or doesn't run in one of the gateway's sites.
func (c *composition) serverNotes(sites []string) []string {
	var notes []string
	for _, m := range sortedModels(c.spec.Models) {
		s, ok := c.servers[m.Server]
		switch {
		case !ok:
		case s.resolved && !s.found:
			notes = append(notes, fmt.Sprintf("model %s: no ModelServer %s in %s", m.Name, m.Server, c.ns))
		default:
			for _, site := range sites {
				if !s.runsIn(site) {
					notes = append(notes, fmt.Sprintf("model %s: ModelServer %s doesn't run in the %s site (its spec.recovery)", m.Name, m.Server, site))
				}
			}
		}
	}
	return notes
}
