// Package render expands controller inputs for offline validation.
package render

import (
	"fmt"
	"io"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"github.com/pood1e/agentos-platform/controller/internal/compile"
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
	result := append([]*unstructured.Unstructured{}, objects...)
	var plans []platform.AccessPlan
	appendObject := func(object client.Object) error {
		gvk, err := apiutil.GVKForObject(object, scheme)
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
		result = append(result, native)
		return nil
	}
	for _, object := range objects {
		if object.GetNamespace() == "" && namespaced(object.GetKind()) {
			object.SetNamespace(namespace)
		}
		if object.GetAPIVersion() != platform.GroupVersion.String() || object.GetKind() != "AccessPlan" {
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
			if err := appendObject(native); err != nil {
				return nil, err
			}
		}
	}
	for _, object := range objects {
		if object.GetAPIVersion() != platform.GroupVersion.String() || object.GetKind() != "Preset" {
			continue
		}
		var preset platform.Preset
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &preset); err != nil {
			return nil, err
		}
		for _, raw := range preset.Spec.Resources {
			native := &unstructured.Unstructured{}
			if err := native.UnmarshalJSON(raw.Raw); err != nil {
				return nil, err
			}
			native.SetNamespace(preset.Namespace)
			if err := compile.Template(native, plans); err != nil {
				return nil, err
			}
			result = append(result, native)
		}
	}
	parents := append([]*unstructured.Unstructured{}, result...)
	for _, object := range parents {
		if object.GetAnnotations()["agentos.dev/connection"] != "true" {
			continue
		}
		var children []client.Object
		var err error
		switch object.GetKind() {
		case "AgentgatewayModel":
			var model agw.AgentgatewayModel
			if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &model); err != nil {
				return nil, err
			}
			children, err = compile.Model(&model, gateway)
		case "AgentgatewayBackend":
			var backend agw.AgentgatewayBackend
			if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &backend); err != nil {
				return nil, err
			}
			children, err = compile.MCP(&backend, gateway)
		}
		if err != nil {
			return nil, err
		}
		for _, child := range children {
			if err := appendObject(child); err != nil {
				return nil, err
			}
		}
	}
	seen := make(map[string]bool)
	for _, object := range result {
		key := object.GetAPIVersion() + "/" + object.GetKind() + "/" + object.GetNamespace() + "/" + object.GetName()
		if seen[key] {
			return nil, fmt.Errorf("duplicate resource %s", key)
		}
		seen[key] = true
	}
	return result, nil
}

func namespaced(kind string) bool {
	switch kind {
	case "CustomResourceDefinition", "Namespace", "ClusterRole", "ClusterRoleBinding", "GatewayClass":
		return false
	}
	return true
}
