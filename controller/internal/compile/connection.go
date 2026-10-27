package compile

import (
	"encoding/json"
	"fmt"
	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"strings"
)

// Model compiles a native model parent into its kagent consumer configuration.
func Model(parent *agw.AgentgatewayModel, gateway platform.PlatformGateway) ([]client.Object, error) {
	model := parent.Name
	if parent.Spec.Match != nil && parent.Spec.Match.Model != nil {
		model = *parent.Spec.Match.Model
	}
	if model == "" || strings.Contains(model, "*") {
		return nil, fmt.Errorf("a concrete model is required")
	}
	var spec kagent.ModelConfigSpec
	if source := parent.Annotations["agentos.dev/model-config"]; source != "" {
		if err := json.Unmarshal([]byte(source), &spec); err != nil {
			return nil, fmt.Errorf("invalid native model configuration: %w", err)
		}
	}
	spec.Model, spec.APIKeySecret, spec.APIKeySecretKey = model, gateway.ModelSecret, "placeholder"
	spec.TokenPassthrough = false
	purpose := parent.Annotations["agentos.dev/model-purpose"]
	if purpose == "" {
		purpose = "language"
	}
	if spec.Provider == kagent.ModelProviderAnthropic {
		if spec.Anthropic == nil {
			spec.Anthropic = &kagent.AnthropicConfig{}
		}
		spec.Anthropic.BaseURL = gateway.URL
		spec.OpenAI = nil
	} else {
		spec.Provider = kagent.ModelProviderOpenAI
		if spec.OpenAI == nil {
			spec.OpenAI = &kagent.OpenAIConfig{}
		}
		spec.OpenAI.BaseURL = strings.TrimRight(gateway.URL, "/") + "/v1"
		if spec.OpenAI.APIFormat == nil && purpose != "embedding" {
			spec.OpenAI.APIFormat = ptr.To(kagent.OpenAIAPIFormatResponses)
		}
		spec.Anthropic = nil
	}
	return []client.Object{&kagent.ModelConfig{ObjectMeta: metav1.ObjectMeta{Name: parent.Name, Namespace: parent.Namespace, Annotations: map[string]string{"agentos.dev/model-purpose": purpose}}, Spec: spec}}, nil
}

// MCP compiles discovery, routing and identity policy for a native MCP connection.
func MCP(parent *agw.AgentgatewayBackend, gateway platform.PlatformGateway) ([]client.Object, error) {
	if parent.Spec.MCP == nil {
		return nil, fmt.Errorf("an MCP backend is required")
	}
	name, namespace := parent.Name, parent.Namespace
	description := parent.Annotations["agentos.dev/description"]
	if description == "" {
		description = name
	}
	return []client.Object{
		Route(namespace, gateway.Name, "http", "mcp-"+name, "/mcp/"+name, name, false),
		Remote(namespace, name, description, strings.TrimRight(gateway.MCPURL, "/")+"/mcp/"+name),
		RuntimePolicy(namespace, &gateway, name, name, gateway.MCPURL, false),
	}, nil
}
