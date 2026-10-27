package reconcile

import (
	"context"
	"errors"
	"reflect"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"github.com/pood1e/agentos-platform/controller/internal/compile"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

// AccessPlan reconciles one complete authorization inventory.
type AccessPlan struct {
	client.Client
	Scheme *runtime.Scheme
	Mode   string
}

func (r *AccessPlan) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	var plan platform.AccessPlan
	if err := r.Get(ctx, request.NamespacedName, &plan); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if plan.Spec.Mode != r.Mode || !plan.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}
	before := plan.DeepCopy()
	result, reconcileErr := compile.Plan(&plan)
	var inventory []platform.ResourceReference
	if reconcileErr == nil {
		for _, desired := range result.Resources {
			ref, err := apply(ctx, r.Client, r.Scheme, &plan, desired, "agentos-access")
			if err != nil {
				reconcileErr = err
				break
			}
			inventory = append(inventory, ref)
		}
	}
	if reconcileErr == nil {
		previous, err := ownedInventory(ctx, r.Client, &plan, r.kinds())
		if err != nil {
			reconcileErr = err
		} else {
			reconcileErr = prune(ctx, r.Client, &plan, append(previous, plan.Status.Resources...), inventory)
		}
	}
	condition := metav1.Condition{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Compiled", Message: "All derived resources have converged", ObservedGeneration: plan.Generation}
	if reconcileErr != nil {
		condition.Status, condition.Reason, condition.Message = metav1.ConditionFalse, "ReconcileFailed", reconcileErr.Error()
		plan.Status.Targets = nil
	} else {
		plan.Status.Targets, plan.Status.Resources = result.Targets, inventory
		plan.Status.ObservedGeneration = plan.Generation
	}
	meta.SetStatusCondition(&plan.Status.Conditions, condition)
	var statusErr error
	if !reflect.DeepEqual(before.Status, plan.Status) {
		statusErr = r.Status().Patch(ctx, &plan, client.MergeFrom(before))
	}
	return ctrl.Result{}, errors.Join(reconcileErr, statusErr)
}

// SetupWithManager watches parents and every supported derived resource.
func (r *AccessPlan) SetupWithManager(manager ctrl.Manager) error {
	builder := ctrl.NewControllerManagedBy(manager).For(&platform.AccessPlan{}).
		Owns(&agw.AgentgatewayBackend{}).Owns(&agw.AgentgatewayPolicy{}).Owns(&gw.HTTPRoute{})
	if r.Mode == "platform" {
		builder = builder.Owns(&kagent.RemoteMCPServer{})
	}
	return builder.Complete(r)
}

var accessKinds = []schema.GroupVersionKind{
	agw.SchemeGroupVersion.WithKind("AgentgatewayBackend"), agw.SchemeGroupVersion.WithKind("AgentgatewayPolicy"),
	gw.SchemeGroupVersion.WithKind("HTTPRoute"), kagent.GroupVersion.WithKind("RemoteMCPServer"),
}

func (r *AccessPlan) kinds() []schema.GroupVersionKind {
	if r.Mode == "environment" {
		return accessKinds[:3]
	}
	return accessKinds
}
