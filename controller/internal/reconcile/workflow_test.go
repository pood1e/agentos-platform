package reconcile

import (
	"encoding/json"
	"testing"

	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func testWorkflowPreset(t *testing.T, c client.Client, scheme *runtime.Scheme, namespace string) {
	t.Helper()
	resource := func(spec string) runtime.RawExtension {
		return runtime.RawExtension{Raw: []byte(`{"apiVersion":"api.kagent.dev/v1alpha3","kind":"AgentTemplate","metadata":{"name":"graph"},"spec":` + spec + `}`)}
	}
	preset := &platform.Preset{
		ObjectMeta: metav1.ObjectMeta{Name: "workflow-preset", Namespace: namespace},
		Spec: platform.PresetSpec{Resources: []runtime.RawExtension{
			resource(`{"modelConfig":{"name":"site-model"},"tools":[]}`),
		}},
	}
	must(t, c.Create(t.Context(), preset))
	controller := &Preset{Client: c, Scheme: scheme}
	reconcile := func() {
		t.Helper()
		_, err := controller.Reconcile(t.Context(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(preset)})
		must(t, err)
		must(t, c.Get(t.Context(), client.ObjectKeyFromObject(preset), preset))
		if !meta.IsStatusConditionTrue(preset.Status.Conditions, "Ready") {
			t.Fatalf("workflow preset is not ready: %+v", preset.Status.Conditions)
		}
	}
	reconcile()
	preset.Spec.Resources = []runtime.RawExtension{resource(`{"workflowFrom":{"name":"graph","key":"workflow.yaml"}}`)}
	must(t, c.Update(t.Context(), preset))
	reconcile()
	var template kagent.AgentTemplate
	must(t, c.Get(t.Context(), client.ObjectKey{Namespace: namespace, Name: "graph"}, &template))
	data, err := json.Marshal(template.Spec)
	must(t, err)
	if string(data) != `{"workflowFrom":{"name":"graph","key":"workflow.yaml"}}` {
		t.Fatalf("workflow retained stale model or tools: %s", data)
	}
	reconcile()
}
