package main

import (
	"context"
	"encoding/json"

	"github.com/crossplane/function-sdk-go/errors"
	"github.com/crossplane/function-sdk-go/logging"
	fnv1 "github.com/crossplane/function-sdk-go/proto/v1"
	"github.com/crossplane/function-sdk-go/request"
	"github.com/crossplane/function-sdk-go/resource"
	"github.com/crossplane/function-sdk-go/response"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/bartvanbenthem/basis-ai/api/function/genaistack"
	"github.com/bartvanbenthem/basis-ai/api/function/location"
	"github.com/bartvanbenthem/basis-ai/api/function/modelgateway"
	"github.com/bartvanbenthem/basis-ai/api/function/postgrescluster"
	"github.com/bartvanbenthem/basis-ai/api/function/project"
	"github.com/bartvanbenthem/basis-ai/api/function/valkeycache"
)

var (
	postgresClusterGVK = schema.GroupVersionKind{Group: "postgres.cndev.nl", Version: "v1alpha1", Kind: "PostgresCluster"}
	valkeyCacheGVK     = schema.GroupVersionKind{Group: "cache.cndev.nl", Version: "v1alpha1", Kind: "ValkeyCache"}
	genAIStackGVK      = schema.GroupVersionKind{Group: "ai.cndev.nl", Version: "v1alpha1", Kind: "GenAIStack"}
	modelGatewayGVK    = schema.GroupVersionKind{Group: "ai.cndev.nl", Version: "v1alpha1", Kind: "ModelGateway"}
	projectGVK         = schema.GroupVersionKind{Group: "platform.cndev.nl", Version: "v1alpha1", Kind: "Project"}
	locationGVK        = schema.GroupVersionKind{Group: "platform.cndev.nl", Version: "v1alpha1", Kind: "Location"}
)

// Function composes BASIS's APIs. It dispatches on the kind of the XR.
type Function struct {
	fnv1.UnimplementedFunctionRunnerServiceServer

	log logging.Logger
}

// RunFunction runs the composition for one XR.
func (f *Function) RunFunction(_ context.Context, req *fnv1.RunFunctionRequest) (*fnv1.RunFunctionResponse, error) {
	rsp := response.To(req, response.DefaultTTL)

	oxr, err := request.GetObservedCompositeResource(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get observed composite resource"))
		return rsp, nil
	}
	log := f.log.WithValues("xr", oxr.Resource.GetName(), "namespace", oxr.Resource.GetNamespace(), "kind", oxr.Resource.GetKind())

	switch gvk := oxr.Resource.GroupVersionKind(); gvk {
	case postgresClusterGVK:
		f.postgresCluster(req, rsp, oxr)
	case valkeyCacheGVK:
		f.valkeyCache(req, rsp, oxr)
	case genAIStackGVK:
		f.genAIStack(req, rsp, oxr)
	case modelGatewayGVK:
		f.modelGateway(req, rsp, oxr)
	case projectGVK:
		f.project(req, rsp, oxr)
	case locationGVK:
		f.location(req, rsp, oxr)
	default:
		response.Fatal(rsp, errors.Errorf("function-basis doesn't compose %s", gvk))
	}
	log.Debug("Composed", "results", len(rsp.GetResults()))
	return rsp, nil
}

// requirement is a resource a composition asks Crossplane for, by name or by
// labels; namespace empty for a cluster-scoped one.
type requirement struct {
	apiVersion, kind, namespace, name string
	labels                            map[string]string
}

// composedResource is one desired composed resource and its readiness.
type composedResource struct {
	object any
	ready  bool
}

// composed is what one composition returns, in a shape both packages map onto.
type composed struct {
	resources     map[string]composedResource
	status        any
	conditionType string
	condition     struct {
		status          bool
		reason, message string
	}
}

func (f *Function) postgresCluster(req *fnv1.RunFunctionRequest, rsp *fnv1.RunFunctionResponse, oxr *resource.Composite) {
	reqs := map[string]requirement{}
	for key, r := range postgrescluster.Requirements(oxr.Resource.GetNamespace()) {
		reqs[key] = requirement{apiVersion: r.APIVersion, kind: r.Kind, name: r.Name}
	}
	compose(req, rsp, oxr, reqs, func(xr map[string]any, observed map[string]map[string]any, required map[string][]map[string]any) (*composed, error) {
		in := postgrescluster.Input{XR: xr, Observed: map[string]postgrescluster.Object{}, Required: map[string][]postgrescluster.Object{}}
		for k, v := range observed {
			in.Observed[k] = v
		}
		for k, v := range required {
			in.Required[k] = append([]postgrescluster.Object{}, v...)
		}
		out, err := postgrescluster.Compose(in)
		if err != nil {
			return nil, err
		}
		c := &composed{status: out.Status, conditionType: "PostgresReady"}
		c.resources = make(map[string]composedResource, len(out.Composed))
		for name, r := range out.Composed {
			c.resources[name] = composedResource{r.Object, r.Ready}
		}
		c.condition.status, c.condition.reason, c.condition.message = out.Condition.Status, out.Condition.Reason, out.Condition.Message
		return c, nil
	})
}

func (f *Function) valkeyCache(req *fnv1.RunFunctionRequest, rsp *fnv1.RunFunctionResponse, oxr *resource.Composite) {
	reqs := map[string]requirement{}
	for key, r := range valkeycache.Requirements(oxr.Resource.GetNamespace()) {
		reqs[key] = requirement{apiVersion: r.APIVersion, kind: r.Kind, name: r.Name}
	}
	compose(req, rsp, oxr, reqs, func(xr map[string]any, observed map[string]map[string]any, required map[string][]map[string]any) (*composed, error) {
		out, err := valkeycache.Compose(valkeycache.Input{XR: xr, Observed: observed, Required: required})
		if err != nil {
			return nil, err
		}
		c := &composed{status: out.Status, conditionType: "CacheReady"}
		c.resources = make(map[string]composedResource, len(out.Composed))
		for name, r := range out.Composed {
			c.resources[name] = composedResource{r.Object, r.Ready}
		}
		c.condition.status, c.condition.reason, c.condition.message = out.Condition.Status, out.Condition.Reason, out.Condition.Message
		return c, nil
	})
}

func (f *Function) genAIStack(req *fnv1.RunFunctionRequest, rsp *fnv1.RunFunctionResponse, oxr *resource.Composite) {
	reqs := map[string]requirement{}
	for key, r := range genaistack.Requirements(oxr.Resource.UnstructuredContent()) {
		reqs[key] = requirement{apiVersion: r.APIVersion, kind: r.Kind, namespace: r.Namespace, name: r.Name}
	}
	compose(req, rsp, oxr, reqs, func(xr map[string]any, observed map[string]map[string]any, required map[string][]map[string]any) (*composed, error) {
		out, err := genaistack.Compose(genaistack.Input{XR: xr, Observed: observed, Required: required})
		if err != nil {
			return nil, err
		}
		c := &composed{status: out.Status, conditionType: "StackReady"}
		c.resources = make(map[string]composedResource, len(out.Composed))
		for name, r := range out.Composed {
			c.resources[name] = composedResource{r.Object, r.Ready}
		}
		c.condition.status, c.condition.reason, c.condition.message = out.Condition.Status, out.Condition.Reason, out.Condition.Message
		return c, nil
	})
}

func (f *Function) modelGateway(req *fnv1.RunFunctionRequest, rsp *fnv1.RunFunctionResponse, oxr *resource.Composite) {
	reqs := map[string]requirement{}
	for key, r := range modelgateway.Requirements(oxr.Resource.GetNamespace()) {
		reqs[key] = requirement{apiVersion: r.APIVersion, kind: r.Kind, namespace: r.Namespace, name: r.Name}
	}
	compose(req, rsp, oxr, reqs, func(xr map[string]any, observed map[string]map[string]any, required map[string][]map[string]any) (*composed, error) {
		out, err := modelgateway.Compose(modelgateway.Input{XR: xr, Observed: observed, Required: required})
		if err != nil {
			return nil, err
		}
		c := &composed{status: out.Status, conditionType: "GatewayReady"}
		c.resources = make(map[string]composedResource, len(out.Composed))
		for name, r := range out.Composed {
			c.resources[name] = composedResource{r.Object, r.Ready}
		}
		c.condition.status, c.condition.reason, c.condition.message = out.Condition.Status, out.Condition.Reason, out.Condition.Message
		return c, nil
	})
}

func (f *Function) project(req *fnv1.RunFunctionRequest, rsp *fnv1.RunFunctionResponse, oxr *resource.Composite) {
	// What the Project needs depends on project-defaults (the backup classes):
	// ask with what Crossplane resolved so far, it calls again until they settle.
	resolved, err := requiredResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get required resources"))
		return
	}
	reqs := map[string]requirement{}
	for key, r := range project.Requirements(oxr.Resource.UnstructuredContent(), resolved) {
		reqs[key] = requirement{r.APIVersion, r.Kind, r.Namespace, r.Name, r.Labels}
	}
	compose(req, rsp, oxr, reqs, func(xr map[string]any, observed map[string]map[string]any, required map[string][]map[string]any) (*composed, error) {
		out := project.Compose(project.Input{XR: xr, Observed: observed, Required: required})
		c := &composed{status: out.Status, conditionType: "ObservabilityReady"}
		c.resources = make(map[string]composedResource, len(out.Composed))
		for name, r := range out.Composed {
			c.resources[name] = composedResource{r.Object, r.Ready}
		}
		c.condition.status, c.condition.reason, c.condition.message = out.Condition.Status, out.Condition.Reason, out.Condition.Message
		return c, nil
	})
}

func (f *Function) location(req *fnv1.RunFunctionRequest, rsp *fnv1.RunFunctionResponse, oxr *resource.Composite) {
	compose(req, rsp, oxr, nil, func(xr map[string]any, observed map[string]map[string]any, _ map[string][]map[string]any) (*composed, error) {
		out := location.Compose(location.Input{XR: xr, Observed: observed})
		c := &composed{status: out.Status, conditionType: "LocationReady"}
		c.resources = make(map[string]composedResource, len(out.Composed))
		for name, r := range out.Composed {
			c.resources[name] = composedResource{r.Object, r.Ready}
		}
		c.condition.status, c.condition.reason, c.condition.message = out.Condition.Status, out.Condition.Reason, out.Condition.Message
		return c, nil
	})
}

// compose asks for the requirements, runs fn on this reconcile's view and
// writes its composed resources, status and condition into the response.
func compose(req *fnv1.RunFunctionRequest, rsp *fnv1.RunFunctionResponse, oxr *resource.Composite,
	reqs map[string]requirement,
	fn func(xr map[string]any, observed map[string]map[string]any, required map[string][]map[string]any) (*composed, error)) {
	// Ask for the requirements every time: Crossplane calls the function
	// again with them once they're resolved.
	requirements := &fnv1.Requirements{Resources: map[string]*fnv1.ResourceSelector{},
		ExtraResources: map[string]*fnv1.ResourceSelector{}} //nolint:staticcheck // Crossplane < 2 reads extra_resources
	for key, r := range reqs {
		sel := &fnv1.ResourceSelector{ApiVersion: r.apiVersion, Kind: r.kind,
			Match: &fnv1.ResourceSelector_MatchName{MatchName: r.name}}
		if r.labels != nil {
			sel.Match = &fnv1.ResourceSelector_MatchLabels{MatchLabels: &fnv1.MatchLabels{Labels: r.labels}}
		}
		if r.namespace != "" {
			ns := r.namespace
			sel.Namespace = &ns
		}
		requirements.Resources[key] = sel
		requirements.ExtraResources[key] = sel //nolint:staticcheck // see above
	}
	rsp.Requirements = requirements

	required, err := requiredResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get required resources"))
		return
	}
	observed, err := request.GetObservedComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get observed composed resources"))
		return
	}
	obs := make(map[string]map[string]any, len(observed))
	for name, o := range observed {
		obs[string(name)] = o.Resource.UnstructuredContent()
	}

	out, err := fn(oxr.Resource.UnstructuredContent(), obs, required)
	if err != nil {
		response.Fatal(rsp, err)
		return
	}

	desired, err := request.GetDesiredComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composed resources"))
		return
	}
	for name, c := range out.resources {
		dc := resource.NewDesiredComposed()
		if err := convert(c.object, &dc.Resource.Object); err != nil {
			response.Fatal(rsp, errors.Wrapf(err, "cannot convert composed resource %s", name))
			return
		}
		dc.Ready = resource.ReadyFalse
		if c.ready {
			dc.Ready = resource.ReadyTrue
		}
		desired[resource.Name(name)] = dc
	}
	if err := response.SetDesiredComposedResources(rsp, desired); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set desired composed resources"))
		return
	}

	dxr, err := request.GetDesiredCompositeResource(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composite resource"))
		return
	}
	var status map[string]any
	if err := convert(out.status, &status); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot convert status"))
		return
	}
	// Over what earlier pipeline steps set.
	current, _ := dxr.Resource.Object["status"].(map[string]any)
	if current == nil {
		current = map[string]any{}
	}
	for k, v := range status {
		current[k] = v
	}
	dxr.Resource.Object["status"] = current
	if err := response.SetDesiredCompositeResource(rsp, dxr); err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot set desired composite resource"))
		return
	}

	// Next to Crossplane's own Ready/Synced (those two types are reserved):
	// the workload's view of health (CNPG's, the Valkey operator's).
	cond := response.ConditionFalse(rsp, out.conditionType, out.condition.reason)
	if out.condition.status {
		cond = response.ConditionTrue(rsp, out.conditionType, out.condition.reason)
	}
	cond.WithMessage(out.condition.message).TargetComposite()
}

// requiredResources returns the resolved requirements as unstructured JSON:
// a name is present once Crossplane has resolved it.
func requiredResources(req *fnv1.RunFunctionRequest) (map[string][]map[string]any, error) {
	resolved, err := request.GetRequiredResources(req)
	if err != nil {
		return nil, err
	}
	if len(resolved) == 0 {
		// Crossplane < 2 answers in extra_resources.
		if resolved, err = request.GetExtraResources(req); err != nil { //nolint:staticcheck // see above
			return nil, err
		}
	}
	out := make(map[string][]map[string]any, len(resolved))
	for name, items := range resolved {
		out[name] = []map[string]any{}
		for _, r := range items {
			out[name] = append(out[name], r.Resource.UnstructuredContent())
		}
	}
	return out, nil
}

// convert round-trips v through JSON into into.
func convert(v, into any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}
