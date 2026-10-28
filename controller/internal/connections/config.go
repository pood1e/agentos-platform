// Package connections supplies AgentOS settings to kagent's gateway integration.
package connections

import (
	"encoding/json"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	"github.com/kagent-dev/kagent/go/integrations/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

// Config keeps application settings and authorization with the platform.
func Config(gateway platform.PlatformGateway) agentgateway.Config {
	return agentgateway.Config{
		Gateway:  gw.ParentReference{Name: gw.ObjectName(gateway.Name), SectionName: ptr.To(gw.SectionName("http"))},
		ModelURL: gateway.URL,
		MCPURL:   gateway.MCPURL,
		MCPPolicy: &agw.Traffic{Transformation: &agw.TransformationOrConditional{Conditional: []agw.TransformationConditional{{
			Condition: "request.path != '/mcp/team-sessions'",
			Policy:    agw.Transformation{Request: &agw.Transform{Remove: []agw.HeaderName{"authorization"}}},
		}}}},
		ModelTemplate: func(parent *agw.AgentgatewayModel) (*kagent.ModelConfig, error) {
			model := &kagent.ModelConfig{}
			if source := parent.Annotations["agentos.dev/model-config"]; source != "" {
				if err := json.Unmarshal([]byte(source), &model.Spec); err != nil {
					return nil, err
				}
			}
			model.Spec.APIKeySecret, model.Spec.APIKeySecretKey = "", ""
			model.Spec.TokenPassthrough = nil
			model.Spec.ActorJWT = &kagent.ActorJWT{Audiences: []string{gateway.URL}}
			purpose := parent.Annotations["agentos.dev/model-purpose"]
			if purpose == "" {
				purpose = "language"
			}
			model.Annotations = map[string]string{"agentos.dev/model-purpose": purpose}
			if purpose == "embedding" {
				model.Spec.ActorJWT = nil
				model.Spec.TokenPassthrough = ptr.To(true)
			}
			if purpose != "embedding" && model.Spec.Provider != kagent.ModelProviderAnthropic {
				if model.Spec.OpenAI == nil {
					model.Spec.OpenAI = &kagent.OpenAIConfig{}
				}
				if model.Spec.OpenAI.APIFormat == nil {
					model.Spec.OpenAI.APIFormat = ptr.To(kagent.OpenAIAPIFormatResponses)
				}
			}
			return model, nil
		},
		MCPTemplate: func(parent *agw.AgentgatewayBackend) (*kagent.RemoteMCPServer, error) {
			description := parent.Annotations["agentos.dev/description"]
			if description == "" {
				description = parent.Name
			}
			remote := &kagent.RemoteMCPServer{

				Spec: kagent.RemoteMCPServerSpec{Description: description, Timeout: &metav1.Duration{Duration: 10 * time.Minute}, ActorJWT: &kagent.ActorJWT{Audiences: []string{gateway.MCPURL}}},
			}
			remote.Spec.DiscoveryAuth = &kagent.MCPDiscoveryAuth{ServiceAccount: &kagent.MCPDiscoveryServiceAccount{ServiceAccountRef: corev1.LocalObjectReference{Name: gateway.DiscoveryServiceAccount}, Audience: "agentos-mcp-discovery"}}
			return remote, nil
		},
	}
}
