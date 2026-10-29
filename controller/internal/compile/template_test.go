package compile

import (
	"reflect"
	"testing"

	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestTemplateUsesLocalMCPServerReference(t *testing.T) {
	object := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "api.kagent.dev/v1alpha3",
		"kind":       "AgentTemplate",
		"metadata":   map[string]any{"name": "asset", "namespace": "agentos"},
		"spec":       map[string]any{"tools": []any{}},
	}}
	plan := platform.AccessPlan{
		ObjectMeta: metav1.ObjectMeta{Name: "connections", Generation: 1},
		Spec:       platform.AccessPlanSpec{Mode: "platform"},
		Status: platform.AccessPlanStatus{
			ObservedGeneration: 1,
			Conditions:         []metav1.Condition{{Type: "Ready", Status: metav1.ConditionTrue}},
			Targets: []platform.CompiledTarget{{
				Server: "lab-ops", Service: "ops", Engineer: "asset", Environment: "lab",
				Tools: []platform.CompiledTool{{Name: "get"}, {Name: "update", Write: true, RequireApproval: true}},
			}},
		},
	}
	if err := Template(object, []platform.AccessPlan{plan}); err != nil {
		t.Fatal(err)
	}
	tools, _, err := unstructured.NestedSlice(object.Object, "spec", "tools")
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 2 {
		t.Fatalf("got %d bindings, want 2", len(tools))
	}
	for _, raw := range tools {
		binding := raw.(map[string]any)["mcp"].(map[string]any)
		server := binding["server"].(map[string]any)
		if _, ok := server["apiGroup"]; ok {
			t.Fatalf("local MCP server reference has apiGroup: %v", server)
		}
		if !reflect.DeepEqual(server, map[string]any{"kind": "RemoteMCPServer", "name": "lab-ops"}) {
			t.Errorf("got server reference %v", server)
		}
	}
}
