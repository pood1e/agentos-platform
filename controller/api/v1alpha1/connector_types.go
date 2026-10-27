package v1alpha1

import agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"

// Connector supplies native MCP destinations for an environment service.
type Connector struct {
	Title string `json:"title,omitempty"`
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=16
	Targets []ConnectorTarget `json:"targets"`
}

// ConnectorTarget adds identity selection to the upstream MCP target contract.
type ConnectorTarget struct {
	agw.McpTarget `json:",inline"`
	Name          string `json:"name,omitempty"`
	// +kubebuilder:validation:MaxItems=3
	// +listType=set
	Access []Access         `json:"access,omitempty"`
	Auth   *agw.BackendAuth `json:"auth,omitempty"`
}
