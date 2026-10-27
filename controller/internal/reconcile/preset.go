package reconcile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	core "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

// Preset maintains solution defaults until a user takes ownership of an object.
type Preset struct {
	client.Client
	Scheme *runtime.Scheme
}

func digest(object *unstructured.Unstructured) string {
	content := make(map[string]any)
	for _, key := range []string{"spec", "data", "binaryData", "type"} {
		if value, ok := object.Object[key]; ok {
			content[key] = value
		}
	}
	data, _ := json.Marshal(content)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func (r *Preset) resource(ctx context.Context, preset *platform.Preset, raw runtime.RawExtension) (platform.PresetResource, error) {
	var object unstructured.Unstructured
	if err := json.Unmarshal(raw.Raw, &object); err != nil {
		return platform.PresetResource{}, err
	}
	if object.GetNamespace() != "" && object.GetNamespace() != preset.Namespace {
		return platform.PresetResource{}, fmt.Errorf("preset resources must belong to the preset namespace")
	}
	object.SetNamespace(preset.Namespace)
	if !supportedPreset(object.GetAPIVersion(), object.GetKind()) {
		return platform.PresetResource{}, fmt.Errorf("unsupported preset resource %s/%s", object.GetAPIVersion(), object.GetKind())
	}
	if err := r.bindings(ctx, &object); err != nil {
		return platform.PresetResource{}, err
	}
	state := platform.PresetResource{ResourceReference: platform.ResourceReference{APIVersion: object.GetAPIVersion(), Kind: object.GetKind(), Name: object.GetName()}, Digest: digest(&object)}
	for _, previous := range preset.Status.Resources {
		if previous.APIVersion == state.APIVersion && previous.Kind == state.Kind && previous.Name == state.Name && previous.UserOwned {
			state.UserOwned, state.UID = true, previous.UID
			return state, nil
		}
	}
	current := object.DeepCopy()
	err := r.Get(ctx, client.ObjectKeyFromObject(&object), current)
	if err != nil && !apierrors.IsNotFound(err) {
		return state, err
	}
	if err == nil {
		if current.GetAnnotations()[UserOwner] == "user" {
			state.UserOwned, state.UID = true, string(current.GetUID())
			return state, userOwned(ctx, r.Client, current, preset.UID)
		}
		if !metav1.IsControlledBy(current, preset) {
			return state, fmt.Errorf("preset target %s already has another owner", object.GetName())
		}
	}
	annotations := object.GetAnnotations()
	if annotations == nil {
		annotations = map[string]string{}
	}
	annotations[PresetOwner], annotations["agentos.dev/preset-digest"] = preset.Name, state.Digest
	object.SetAnnotations(annotations)
	ref, err := apply(ctx, r.Client, r.Scheme, preset, &object, "agentos-presets")
	if apierrors.IsConflict(err) {
		state.UserOwned, state.UID = true, string(current.GetUID())
		return state, userOwned(ctx, r.Client, current, preset.UID)
	}
	state.ResourceReference = ref
	return state, err
}

func supportedPreset(version, kind string) bool {
	switch version {
	case "api.kagent.dev/v1alpha3":
		return kind == "Agent" || kind == "AgentTemplate" || kind == "Harness" || kind == "ModelConfig"
	case "agentgateway.dev/v1alpha1":
		return kind == "AgentgatewayModel" || kind == "AgentgatewayBackend"
	case "v1":
		return kind == "ConfigMap" || kind == "Secret"
	default:
		return false
	}
}

func (r *Preset) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	var preset platform.Preset
	if err := r.Get(ctx, request.NamespacedName, &preset); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !preset.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}
	before := preset.DeepCopy()
	var records []platform.PresetResource
	var desired []platform.ResourceReference
	var reconcileErr error
	for _, raw := range preset.Spec.Resources {
		state, err := r.resource(ctx, &preset, raw)
		if err != nil {
			reconcileErr = err
			break
		}
		records, desired = append(records, state), append(desired, state.ResourceReference)
	}
	if reconcileErr == nil {
		previous, err := ownedInventory(ctx, r.Client, &preset, presetKinds)
		if err != nil {
			return ctrl.Result{}, err
		}
		for _, state := range preset.Status.Resources {
			if !state.UserOwned {
				previous = append(previous, state.ResourceReference)
			}
		}
		reconcileErr = prune(ctx, r.Client, &preset, previous, desired)
	}
	condition := metav1.Condition{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Applied", Message: "Preset resources have converged", ObservedGeneration: preset.Generation}
	if reconcileErr != nil {
		condition.Status, condition.Reason, condition.Message = metav1.ConditionFalse, "ReconcileFailed", reconcileErr.Error()
	} else {
		preset.Status.Resources, preset.Status.ObservedGeneration = records, preset.Generation
	}
	meta.SetStatusCondition(&preset.Status.Conditions, condition)
	var statusErr error
	if !reflect.DeepEqual(before.Status, preset.Status) {
		statusErr = r.Status().Patch(ctx, &preset, client.MergeFrom(before))
	}
	return ctrl.Result{}, errors.Join(reconcileErr, statusErr)
}

// SetupWithManager watches native edits and authorization changes that affect presets.
func (r *Preset) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).For(&platform.Preset{}).
		Owns(&kagent.Agent{}).Owns(&kagent.AgentTemplate{}).Owns(&kagent.Harness{}).Owns(&kagent.ModelConfig{}).
		Owns(&agw.AgentgatewayModel{}).Owns(&agw.AgentgatewayBackend{}).Owns(&core.ConfigMap{}).Owns(&core.Secret{}).
		Watches(&platform.AccessPlan{}, handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, object client.Object) []reconcile.Request {
			var presets platform.PresetList
			if err := r.List(ctx, &presets, client.InNamespace(object.GetNamespace())); err != nil {
				ctrl.LoggerFrom(ctx).Error(err, "List presets")
				return nil
			}
			requests := make([]reconcile.Request, 0, len(presets.Items))
			for _, preset := range presets.Items {
				requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&preset)})
			}
			return requests
		})).Complete(r)
}

var presetKinds = []schema.GroupVersionKind{
	kagent.GroupVersion.WithKind("Agent"), kagent.GroupVersion.WithKind("AgentTemplate"), kagent.GroupVersion.WithKind("Harness"), kagent.GroupVersion.WithKind("ModelConfig"),
	agw.SchemeGroupVersion.WithKind("AgentgatewayModel"), agw.SchemeGroupVersion.WithKind("AgentgatewayBackend"), core.SchemeGroupVersion.WithKind("ConfigMap"), core.SchemeGroupVersion.WithKind("Secret"),
}
