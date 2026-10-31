package compile

import (
	"fmt"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"slices"
)

// Template adds compiled environment bindings to a native AgentTemplate.
func Template(object *unstructured.Unstructured, plans []platform.AccessPlan) error {
	if object.GetKind() != "AgentTemplate" {
		return nil
	}
	groups := make(map[string]*kagent.MCPToolBinding)
	for _, plan := range plans {
		if plan.Spec.Mode != "platform" {
			continue
		}
		if plan.Status.ObservedGeneration != plan.Generation || !meta.IsStatusConditionTrue(plan.Status.Conditions, "Ready") {
			return fmt.Errorf("access plan %s is not ready", plan.Name)
		}
		for _, target := range plan.Status.Targets {
			if target.Engineer != object.GetName() || target.Environment == "" {
				continue
			}
			for _, tool := range target.Tools {
				key := fmt.Sprintf("%s:%t", target.Server, tool.RequireApproval)
				binding := groups[key]
				if binding == nil {
					binding = &kagent.MCPToolBinding{Server: core.TypedLocalObjectReference{Kind: "RemoteMCPServer", Name: target.Server}, RequireApproval: tool.RequireApproval}
					groups[key] = binding
				}
				name := target.Service + "_" + tool.Name
				found := false
				for _, selected := range binding.Tools {
					if selected == name {
						found = true
						break
					}
				}
				if !found {
					binding.Tools = append(binding.Tools, name)
				}
			}
		}
	}
	if len(groups) == 0 {
		return nil
	}
	tools, _, err := unstructured.NestedSlice(object.Object, "spec", "tools")
	if err != nil {
		return err
	}
	for _, key := range sortedBindingKeys(groups) {
		binding := groups[key]
		converted, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&kagent.ToolBinding{MCP: binding})
		if err != nil {
			return err
		}
		unstructured.RemoveNestedField(converted, "mcp", "server", "apiGroup")
		if err := unstructured.SetNestedField(converted, binding.RequireApproval, "mcp", "requireApproval"); err != nil {
			return err
		}
		tools = append(tools, converted)
	}
	return unstructured.SetNestedSlice(object.Object, tools, "spec", "tools")
}

func sortedBindingKeys(groups map[string]*kagent.MCPToolBinding) []string {
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	// Ordering is part of the deterministic preset digest.
	slices.Sort(keys)
	return keys
}
