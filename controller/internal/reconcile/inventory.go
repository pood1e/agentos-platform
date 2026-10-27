// Package reconcile maintains native resources using server-side apply and owner references.
package reconcile

import (
	"context"
	"fmt"

	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"
)

const UserOwner = "agentos.dev/ownership"
const PresetOwner = "agentos.dev/preset"
const ownerLabel = "agentos.dev/owner-uid"

func apply(ctx context.Context, c client.Client, scheme *runtime.Scheme, parent, desired client.Object, manager string) (platform.ResourceReference, error) {
	gvk, err := apiutil.GVKForObject(desired, scheme)
	if err != nil {
		return platform.ResourceReference{}, err
	}
	desired.GetObjectKind().SetGroupVersionKind(gvk)
	desired.SetNamespace(parent.GetNamespace())
	current := desired.DeepCopyObject().(client.Object)
	err = c.Get(ctx, client.ObjectKeyFromObject(desired), current)
	if err != nil && !apierrors.IsNotFound(err) {
		return platform.ResourceReference{}, err
	}
	if err == nil && !metav1.IsControlledBy(current, parent) {
		return platform.ResourceReference{}, fmt.Errorf("%s %s already has another owner", gvk.Kind, desired.GetName())
	}
	if err := ctrl.SetControllerReference(parent, desired, scheme); err != nil {
		return platform.ResourceReference{}, err
	}
	labels := desired.GetLabels()
	if labels == nil {
		labels = map[string]string{}
	}
	labels[ownerLabel] = string(parent.GetUID())
	desired.SetLabels(labels)
	options := []client.PatchOption{client.FieldOwner(manager)}
	if manager != "agentos-presets" {
		options = append(options, client.ForceOwnership)
	}
	if err := c.Patch(ctx, desired, client.Apply, options...); err != nil {
		return platform.ResourceReference{}, err
	}
	return platform.ResourceReference{APIVersion: gvk.GroupVersion().String(), Kind: gvk.Kind, Name: desired.GetName(), UID: string(desired.GetUID())}, nil
}

func objectFor(ref platform.ResourceReference, namespace string) *unstructured.Unstructured {
	object := &unstructured.Unstructured{}
	object.SetGroupVersionKind(schema.FromAPIVersionAndKind(ref.APIVersion, ref.Kind))
	object.SetNamespace(namespace)
	object.SetName(ref.Name)
	return object
}

func prune(ctx context.Context, c client.Client, parent client.Object, previous, desired []platform.ResourceReference) error {
	retained := make(map[string]bool, len(desired))
	key := func(ref platform.ResourceReference) string { return ref.APIVersion + "/" + ref.Kind + "/" + ref.Name }
	for _, ref := range desired {
		retained[key(ref)] = true
	}
	for _, ref := range previous {
		if retained[key(ref)] {
			continue
		}
		object := objectFor(ref, parent.GetNamespace())
		if err := c.Get(ctx, client.ObjectKeyFromObject(object), object); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return err
		}
		if !metav1.IsControlledBy(object, parent) || (ref.UID != "" && string(object.GetUID()) != ref.UID) {
			continue
		}
		uid := object.GetUID()
		if err := c.Delete(ctx, object, client.Preconditions{UID: &uid}); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

// ownedInventory recovers resources applied before the parent's status was persisted.
func ownedInventory(ctx context.Context, c client.Client, parent client.Object, kinds []schema.GroupVersionKind) ([]platform.ResourceReference, error) {
	var result []platform.ResourceReference
	for _, kind := range kinds {
		list := &unstructured.UnstructuredList{}
		list.SetGroupVersionKind(kind.GroupVersion().WithKind(kind.Kind + "List"))
		if err := c.List(ctx, list, client.InNamespace(parent.GetNamespace()), client.MatchingLabels{ownerLabel: string(parent.GetUID())}); err != nil {
			return nil, err
		}
		for _, object := range list.Items {
			if metav1.IsControlledBy(&object, parent) {
				result = append(result, platform.ResourceReference{APIVersion: kind.GroupVersion().String(), Kind: kind.Kind, Name: object.GetName(), UID: string(object.GetUID())})
			}
		}
	}
	return result, nil
}

func userOwned(ctx context.Context, c client.Client, object client.Object, parentUID types.UID) error {
	before := object.DeepCopyObject().(client.Object)
	annotations := object.GetAnnotations()
	if annotations == nil {
		annotations = map[string]string{}
	}
	annotations[UserOwner] = "user"
	object.SetAnnotations(annotations)
	owners := object.GetOwnerReferences()
	retained := make([]metav1.OwnerReference, 0, len(owners))
	for _, owner := range owners {
		if owner.UID != parentUID {
			retained = append(retained, owner)
		}
	}
	object.SetOwnerReferences(retained)
	return c.Patch(ctx, object, client.MergeFrom(before), client.FieldOwner("agentos-users"))
}
