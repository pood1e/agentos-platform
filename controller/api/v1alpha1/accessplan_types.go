package v1alpha1

import metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

// Toolset declares disjoint capability tiers for one service.
type Toolset struct {
	// +kubebuilder:validation:MaxItems=100
	// +listType=set
	ReadOnly []string `json:"readOnly,omitempty"`
	// +kubebuilder:validation:MaxItems=100
	// +listType=set
	Write []string `json:"write,omitempty"`
	// +kubebuilder:validation:MaxItems=100
	// +listType=set
	ManagementReadOnly []string `json:"managementReadOnly,omitempty"`
	// +kubebuilder:validation:MaxItems=100
	// +listType=set
	Management []string `json:"management,omitempty"`
	// Omitted approvals default to every write capability; an empty list requires none.
	// +kubebuilder:validation:MaxItems=200
	// +listType=set
	Approval *[]string `json:"approval,omitempty"`
}

// Access identifies an identity's capability boundary.
// +kubebuilder:validation:Enum=read;operate;manage
type Access string

// Identity selects services and optionally restricts the environments in which it exists.
type Identity struct {
	// +kubebuilder:validation:Pattern=`^[a-z0-9]+(-[a-z0-9]+)*$`
	// +kubebuilder:validation:MaxLength=63
	Name string `json:"name"`
	// +kubebuilder:validation:MaxItems=32
	// +listType=set
	Environments []string `json:"environments,omitempty"`
	// +kubebuilder:validation:MaxProperties=32
	Services map[string]Access `json:"services"`
}

// EnvironmentGateway is the TLS gateway exposed by a connected environment.
type EnvironmentGateway struct {
	Address string `json:"address"`
	Host    string `json:"host"`
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	NodePort int32 `json:"nodePort"`
}

// Environment declares one external environment's authorization boundary.
type Environment struct {
	// +kubebuilder:validation:Pattern=`^[a-z0-9]+(-[a-z0-9]+)*$`
	// +kubebuilder:validation:MaxLength=32
	Name string `json:"name"`
	// +kubebuilder:validation:Enum=approval;direct
	Governance string `json:"governance"`
	// +kubebuilder:validation:Pattern=`^https://[^/]+`
	Issuer string `json:"issuer,omitempty"`
	// +kubebuilder:validation:Pattern=`^https://[^/]+`
	Resource string `json:"resource,omitempty"`
	// +kubebuilder:validation:Pattern=`^https://[^/]+`
	JWKSURL string              `json:"jwksURL,omitempty"`
	Gateway *EnvironmentGateway `json:"gateway,omitempty"`
	// +kubebuilder:validation:MaxProperties=32
	Toolsets map[string]Toolset `json:"toolsets,omitempty"`
	// +kubebuilder:validation:MaxItems=64
	// +listType=map
	// +listMapKey=name
	Identities []Identity        `json:"identities,omitempty"`
	Titles     map[string]string `json:"titles,omitempty"`
}

// PlatformGateway supplies the native gateway and the platform service endpoints.
type PlatformGateway struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	MCPURL      string `json:"mcpURL"`
	ModelSecret string `json:"modelSecret"`
	Dataplane   string `json:"dataplane"`
	ActorKeys   string `json:"actorKeys"`
	ActorIssuer string `json:"actorIssuer"`
}

// AccessPlanSpec is the sole source of tool tiers and identity compilation.
type AccessPlanSpec struct {
	// +kubebuilder:validation:Enum=platform;environment
	Mode     string           `json:"mode"`
	Platform *PlatformGateway `json:"platform,omitempty"`
	// +kubebuilder:validation:MaxItems=32
	// +listType=map
	// +listMapKey=name
	Environments []Environment `json:"environments,omitempty"`
	// +kubebuilder:validation:MaxProperties=32
	Toolsets map[string]Toolset `json:"toolsets,omitempty"`
	// +kubebuilder:validation:MaxItems=64
	// +listType=map
	// +listMapKey=name
	Identities []Identity `json:"identities,omitempty"`
	// +kubebuilder:validation:MaxProperties=32
	Servers map[string]Toolset `json:"servers,omitempty"`
	// +kubebuilder:validation:MaxProperties=32
	Connectors map[string]Connector `json:"connectors,omitempty"`
}

// CompiledTool is a fully resolved tool decision. Unknown tools have no decision.
type CompiledTool struct {
	Name            string `json:"name"`
	Write           bool   `json:"write"`
	RequireApproval bool   `json:"requireApproval"`
}

// CompiledTarget identifies a server and its already compiled capabilities.
type CompiledTarget struct {
	Server      string `json:"server"`
	Service     string `json:"service"`
	Project     string `json:"project,omitempty"`
	Environment string `json:"environment,omitempty"`
	Engineer    string `json:"engineer,omitempty"`
	Catalog     bool   `json:"catalog"`
	// +kubebuilder:validation:Enum=readOnly;write
	Access string         `json:"access,omitempty"`
	Tools  []CompiledTool `json:"tools,omitempty"`
}

// ResourceReference records the identity of a resource owned by a controller.
type ResourceReference struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	UID        string `json:"uid,omitempty"`
}

// AccessPlanStatus is published only after every derived resource has converged.
type AccessPlanStatus struct {
	ObservedGeneration int64               `json:"observedGeneration,omitempty"`
	Targets            []CompiledTarget    `json:"targets,omitempty"`
	Resources          []ResourceReference `json:"resources,omitempty"`
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// AccessPlan compiles tool and identity configuration into native resources.
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
type AccessPlan struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              AccessPlanSpec   `json:"spec"`
	Status            AccessPlanStatus `json:"status,omitempty"`
}

// AccessPlanList contains AccessPlan resources.
// +kubebuilder:object:root=true
type AccessPlanList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AccessPlan `json:"items"`
}

func init() { SchemeBuilder.Register(&AccessPlan{}, &AccessPlanList{}) }
