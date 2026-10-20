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

	"github.com/bartvanbenthem/basis-ai/api/function/postgrescluster"
)

var postgresClusterGVK = schema.GroupVersionKind{Group: "cnpg.cndev.nl", Version: "v1alpha1", Kind: "PostgresCluster"}

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
	default:
		response.Fatal(rsp, errors.Errorf("function-basis doesn't compose %s", gvk))
	}
	log.Debug("Composed", "results", len(rsp.GetResults()))
	return rsp, nil
}

func (f *Function) postgresCluster(req *fnv1.RunFunctionRequest, rsp *fnv1.RunFunctionResponse, oxr *resource.Composite) {
	// Ask for the Project and the catalogs every time: Crossplane calls the
	// function again with them once they're resolved.
	requirements := &fnv1.Requirements{Resources: map[string]*fnv1.ResourceSelector{},
		ExtraResources: map[string]*fnv1.ResourceSelector{}} //nolint:staticcheck // Crossplane < 2 reads extra_resources
	for key, r := range postgrescluster.Requirements(oxr.Resource.GetNamespace()) {
		sel := &fnv1.ResourceSelector{ApiVersion: r.APIVersion, Kind: r.Kind,
			Match: &fnv1.ResourceSelector_MatchName{MatchName: r.Name}}
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
	in := postgrescluster.Input{XR: oxr.Resource.UnstructuredContent(), Observed: map[string]postgrescluster.Object{}, Required: required}
	for name, o := range observed {
		in.Observed[string(name)] = o.Resource.UnstructuredContent()
	}

	out, err := postgrescluster.Compose(in)
	if err != nil {
		response.Fatal(rsp, err)
		return
	}

	desired, err := request.GetDesiredComposedResources(req)
	if err != nil {
		response.Fatal(rsp, errors.Wrap(err, "cannot get desired composed resources"))
		return
	}
	for name, c := range out.Composed {
		dc := resource.NewDesiredComposed()
		if err := convert(c.Object, &dc.Resource.Object); err != nil {
			response.Fatal(rsp, errors.Wrapf(err, "cannot convert composed resource %s", name))
			return
		}
		dc.Ready = resource.ReadyFalse
		if c.Ready {
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
	if err := convert(out.Status, &status); err != nil {
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
	// CNPG's view of health.
	cond := response.ConditionFalse(rsp, "PostgresReady", out.Condition.Reason)
	if out.Condition.Status {
		cond = response.ConditionTrue(rsp, "PostgresReady", out.Condition.Reason)
	}
	cond.WithMessage(out.Condition.Message).TargetComposite()
}

// requiredResources returns the resolved requirements as unstructured JSON:
// a name is present once Crossplane has resolved it.
func requiredResources(req *fnv1.RunFunctionRequest) (map[string][]postgrescluster.Object, error) {
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
	out := make(map[string][]postgrescluster.Object, len(resolved))
	for name, items := range resolved {
		out[name] = []postgrescluster.Object{}
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
