package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// PresetSpec contains native resources shipped by a solution package.
type PresetSpec struct {
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=100
	Resources []runtime.RawExtension `json:"resources"`
}

// PresetResource tracks the applied content and retained user ownership.
type PresetResource struct {
	ResourceReference `json:",inline"`
	Digest            string `json:"digest,omitempty"`
	UserOwned         bool   `json:"userOwned,omitempty"`
}

// PresetStatus records the last converged generation and individual ownership.
type PresetStatus struct {
	ObservedGeneration int64            `json:"observedGeneration,omitempty"`
	Resources          []PresetResource `json:"resources,omitempty"`
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// Preset applies unmodified solution resources and retains user customizations.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
type Preset struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              PresetSpec   `json:"spec"`
	Status            PresetStatus `json:"status,omitempty"`
}

// PresetList contains Preset resources.
// +kubebuilder:object:root=true
type PresetList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Preset `json:"items"`
}

func init() { SchemeBuilder.Register(&Preset{}, &PresetList{}) }
