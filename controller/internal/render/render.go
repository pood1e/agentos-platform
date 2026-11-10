// Package render expands controller inputs for offline validation.
package render

import (
	"fmt"
	"io"
	"slices"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	"github.com/kagent-dev/kagent/go/integrations/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"github.com/pood1e/agentos-platform/controller/internal/compile"
	"github.com/pood1e/agentos-platform/controller/internal/connections"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"
)

// Read decodes Kubernetes YAML or JSON documents.
func Read(reader io.Reader) ([]*unstructured.Unstructured, error) {
	decoder := yaml.NewYAMLOrJSONDecoder(reader, 4096)
	var result []*unstructured.Unstructured
	for {
		object := &unstructured.Unstructured{}
		if err := decoder.Decode(object); err != nil {
			if err == io.EOF {
				return result, nil
			}
			return nil, err
		}
		if len(object.Object) > 0 {
			result = append(result, object)
		}
	}
}

// Expand uses the same compiler as reconciliation, without a Kubernetes cluster.
func Expand(objects []*unstructured.Unstructured, scheme *runtime.Scheme, namespace string, gateway platform.PlatformGateway) ([]*unstructured.Unstructured, error) {
	for _, object := range objects {
		if object.GetNamespace() == "" && namespaced(object.GetKind()) {
			object.SetNamespace(namespace)
		}
	}
	expanded := expansion{scheme: scheme, result: slices.Clone(objects)}
	plans, err := expanded.accessPlans(objects)
	if err != nil {
		return nil, err
	}
	if err := expanded.presets(objects, plans); err != nil {
		return nil, err
	}
	if err := expanded.connections(connections.Config(gateway)); err != nil {
		return nil, err
	}
	return expanded.result, expanded.unique()
}

type expansion struct {
	scheme *runtime.Scheme
	result []*unstructured.Unstructured
}

func (e *expansion) add(object client.Object) error {
	gvk, err := apiutil.GVKForObject(object, e.scheme)
	if err != nil {
		return err
	}
	value, err := runtime.DefaultUnstructuredConverter.ToUnstructured(object)
	if err != nil {
		return err
	}
	delete(value, "status")
	native := &unstructured.Unstructured{Object: value}
	native.SetGroupVersionKind(gvk)
	e.result = append(e.result, native)
	return nil
}

func isPlatformKind(object *unstructured.Unstructured, kind string) bool {
	return object.GetAPIVersion() == platform.GroupVersion.String() && object.GetKind() == kind
}

// accessPlans records compiled status on each plan and adds its derived resources.
func (e *expansion) accessPlans(objects []*unstructured.Unstructured) ([]platform.AccessPlan, error) {
	var plans []platform.AccessPlan
	for _, object := range objects {
		if !isPlatformKind(object, "AccessPlan") {
			continue
		}
		var plan platform.AccessPlan
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &plan); err != nil {
			return nil, err
		}
		compiled, err := compile.Plan(&plan)
		if err != nil {
			return nil, fmt.Errorf("access plan %s: %w", plan.Name, err)
		}
		plan.Status.Targets, plan.Status.ObservedGeneration = compiled.Targets, plan.Generation
		meta.SetStatusCondition(&plan.Status.Conditions, metav1.Condition{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Compiled", Message: "Offline compilation", LastTransitionTime: metav1.Unix(0, 0), ObservedGeneration: plan.Generation})
		value, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&plan)
		if err != nil {
			return nil, err
		}
		object.Object["status"] = value["status"]
		plans = append(plans, plan)
		for _, native := range compiled.Resources {
			if err := e.add(native); err != nil {
				return nil, err
			}
		}
	}
	return plans, nil
}

func (e *expansion) presets(objects []*unstructured.Unstructured, plans []platform.AccessPlan) error {
	for _, object := range objects {
		if !isPlatformKind(object, "Preset") {
			continue
		}
		var preset platform.Preset
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &preset); err != nil {
			return err
		}
		for _, raw := range preset.Spec.Resources {
			native := &unstructured.Unstructured{}
			if err := native.UnmarshalJSON(raw.Raw); err != nil {
				return err
			}
			native.SetNamespace(preset.Namespace)
			if err := compile.Template(native, plans); err != nil {
				return err
			}
			e.result = append(e.result, native)
		}
	}
	return nil
}

// connections derives gateway children of every annotated connection found so far.
func (e *expansion) connections(config agentgateway.Config) error {
	for _, object := range slices.Clone(e.result) {
		if object.GetAnnotations()[agentgateway.ConnectionAnnotation] != "true" {
			continue
		}
		children, err := connectionChildren(object, config)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := e.add(child); err != nil {
				return err
			}
		}
	}
	return nil
}

func connectionChildren(object *unstructured.Unstructured, config agentgateway.Config) ([]client.Object, error) {
	switch object.GetKind() {
	case "AgentgatewayModel":
		var model agw.AgentgatewayModel
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &model); err != nil {
			return nil, err
		}
		child, err := config.Model(&model)
		return []client.Object{child}, err
	case "AgentgatewayBackend":
		var backend agw.AgentgatewayBackend
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &backend); err != nil {
			return nil, err
		}
		return config.MCP(&backend)
	}
	return nil, nil
}

func (e *expansion) unique() error {
	seen := make(map[string]bool)
	for _, object := range e.result {
		key := object.GetAPIVersion() + "/" + object.GetKind() + "/" + object.GetNamespace() + "/" + object.GetName()
		if seen[key] {
			return fmt.Errorf("duplicate resource %s", key)
		}
		seen[key] = true
	}
	return nil
}

func namespaced(kind string) bool {
	switch kind {
	case "CustomResourceDefinition", "Namespace", "ClusterRole", "ClusterRoleBinding", "GatewayClass":
		return false
	}
	return true
}
