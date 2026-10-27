package reconcile

import (
	"context"
	"fmt"

	"errors"
	"reflect"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"github.com/pood1e/agentos-platform/controller/internal/compile"
	core "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

// Connection derives kagent consumer resources from one native gateway parent.
type Connection struct {
	client.Client
	Scheme  *runtime.Scheme
	Gateway platform.PlatformGateway
	Model   bool
}

func (r *Connection) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	var parent client.Object = &agw.AgentgatewayBackend{}
	if r.Model {
		parent = &agw.AgentgatewayModel{}
	}
	if err := r.Get(ctx, request.NamespacedName, parent); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if parent.GetAnnotations()["agentos.dev/connection"] != "true" || !parent.GetDeletionTimestamp().IsZero() {
		return ctrl.Result{}, nil
	}
	var children []client.Object
	var reconcileErr error
	if r.Model {
		children, reconcileErr = compile.Model(parent.(*agw.AgentgatewayModel), r.Gateway)
	} else {
		children, reconcileErr = compile.MCP(parent.(*agw.AgentgatewayBackend), r.Gateway)
	}
	if reconcileErr == nil {
		reconcileErr = r.credential(ctx, parent)
	}
	if reconcileErr == nil {
		for _, child := range children {
			if _, err := apply(ctx, r.Client, r.Scheme, parent, child, "agentos-connections"); err != nil {
				reconcileErr = err
				break
			}
		}
	}
	return ctrl.Result{}, errors.Join(reconcileErr, r.condition(ctx, parent, reconcileErr))
}

func (r *Connection) credential(ctx context.Context, parent client.Object) error {
	var reference *agw.LocalSecretKeyRef
	switch p := parent.(type) {
	case *agw.AgentgatewayModel:
		if p.Spec.Policies != nil && p.Spec.Policies.Auth != nil {
			reference = p.Spec.Policies.Auth.SecretRef
		}
	case *agw.AgentgatewayBackend:
		if p.Spec.Policies != nil && p.Spec.Policies.Auth != nil {
			reference = p.Spec.Policies.Auth.SecretRef
		}
	}
	if reference == nil {
		return nil
	}
	var secret core.Secret
	if err := r.Get(ctx, client.ObjectKey{Namespace: parent.GetNamespace(), Name: string(reference.Name)}, &secret); err != nil {
		return fmt.Errorf("connection credential %s: %w", reference.Name, err)
	}
	return nil
}

func (r *Connection) condition(ctx context.Context, parent client.Object, reconcileErr error) error {
	value, err := runtime.DefaultUnstructuredConverter.ToUnstructured(parent)
	if err != nil {
		return err
	}
	object := &unstructured.Unstructured{Object: value}
	gvk, err := apiutil.GVKForObject(parent, r.Scheme)
	if err != nil {
		return err
	}
	object.SetGroupVersionKind(gvk)
	before := object.DeepCopy()
	conditions := []metav1.Condition{}
	raw, _, _ := unstructured.NestedSlice(value, "status", "conditions")
	for _, entry := range raw {
		condition := metav1.Condition{}
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(item, &condition); err != nil {
			return err
		}
		conditions = append(conditions, condition)
	}
	condition := metav1.Condition{Type: "AgentOSReady", Status: metav1.ConditionTrue, Reason: "Reconciled", Message: "Connection resources have converged", ObservedGeneration: parent.GetGeneration()}
	if reconcileErr != nil {
		condition.Status, condition.Reason, condition.Message = metav1.ConditionFalse, "ReconcileFailed", reconcileErr.Error()
	}
	meta.SetStatusCondition(&conditions, condition)
	entries := make([]any, 0, len(conditions))
	for _, condition := range conditions {
		entry, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&condition)
		if err != nil {
			return err
		}
		entries = append(entries, entry)
	}
	if err := unstructured.SetNestedSlice(object.Object, entries, "status", "conditions"); err != nil {
		return err
	}
	if reflect.DeepEqual(before.Object["status"], object.Object["status"]) {
		return nil
	}
	return r.Status().Patch(ctx, object, client.MergeFromWithOptions(before, client.MergeFromWithOptimisticLock{}))
}

// SetupWithManager registers the selected parent kind and its derived resources.
func (r *Connection) SetupWithManager(manager ctrl.Manager) error {
	if r.Model {
		return ctrl.NewControllerManagedBy(manager).Named("model-connection").For(&agw.AgentgatewayModel{}).Owns(&core.Secret{}).Owns(&kagent.ModelConfig{}).Complete(r)
	}
	return ctrl.NewControllerManagedBy(manager).Named("mcp-connection").For(&agw.AgentgatewayBackend{}).Owns(&core.Secret{}).Owns(&kagent.RemoteMCPServer{}).Owns(&gw.HTTPRoute{}).Owns(&agw.AgentgatewayPolicy{}).Complete(r)
}
