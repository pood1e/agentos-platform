package compile

import (
	"reflect"
	"testing"

	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
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

func TestTemplatePreservesDeclarativeWorkflowSource(t *testing.T) {
	object := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "api.kagent.dev/v1alpha3",
		"kind":       "AgentTemplate",
		"metadata":   map[string]any{"name": "rca", "namespace": "agentos"},
		"spec": map[string]any{
			"modelConfig":  map[string]any{"name": "site-model"},
			"workflowFrom": map[string]any{"name": "rca", "key": "workflow.yaml"},
		},
	}}
	if err := Template(object, nil); err != nil {
		t.Fatal(err)
	}
	var native kagent.AgentTemplate
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &native); err != nil {
		t.Fatal(err)
	}
	if native.Spec.WorkflowFrom == nil || native.Spec.WorkflowFrom.Name != "rca" || native.Spec.WorkflowFrom.Key != "workflow.yaml" {
		t.Fatalf("workflow source was lost: %+v", native.Spec.WorkflowFrom)
	}
}

func TestTemplatePreservesWorkflowWithoutToolBindings(t *testing.T) {
	object := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "api.kagent.dev/v1alpha3",
		"kind":       "AgentTemplate",
		"metadata":   map[string]any{"name": "graph", "namespace": "agentos"},
		"spec": map[string]any{
			"workflowFrom": map[string]any{"name": "graph", "key": "workflow.yaml"},
		},
	}}
	want := object.DeepCopy()
	if err := Template(object, nil); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(object.Object, want.Object) {
		t.Fatalf("unbound workflow changed: got %v, want %v", object.Object, want.Object)
	}
}
