package reconcile

import (
	"context"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"github.com/pood1e/agentos-platform/controller/internal/compile"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func (r *Preset) bindings(ctx context.Context, object *unstructured.Unstructured) error {
	if object.GetKind() != "AgentTemplate" {
		return nil
	}
	var plans platform.AccessPlanList
	if err := r.List(ctx, &plans, client.InNamespace(object.GetNamespace())); err != nil {
		return err
	}
	return compile.Template(object, plans.Items)
}
