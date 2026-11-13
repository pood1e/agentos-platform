package connections

import (
	"testing"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func TestModelSettings(t *testing.T) {
	config := Config(platform.PlatformGateway{Name: "gateway", URL: "http://models.test:8080"})
	source := &agw.AgentgatewayModel{
		ObjectMeta: metav1.ObjectMeta{Name: "model", Namespace: "team", Annotations: map[string]string{
			"agentos.dev/model-config": `{"provider":"OpenAI","openAI":{"temperature":"0.4"}}`,
		}},
		Spec: agw.AgentgatewayModelSpec{
			ParentRefs: []gw.ParentReference{config.Gateway}, Match: &agw.ModelMatch{Model: ptr.To("upstream-model")},
		},
	}
	model, err := config.Model(source)
	if err != nil {
		t.Fatal(err)
	}
	if model.Spec.Model != "upstream-model" || model.Spec.OpenAI.BaseURL != "http://models.test:8080/v1" ||
		model.Spec.OpenAI.Temperature != "0.4" || model.Spec.OpenAI.APIFormat == nil || *model.Spec.OpenAI.APIFormat != kagent.OpenAIAPIFormatResponses {
		t.Fatalf("model settings lost: %+v", model.Spec)
	}
	if model.Spec.APIKeySecret != "" || model.Spec.APIKeySecretKey != "" || model.Spec.TokenPassthrough != nil || model.Spec.ActorJWT == nil || model.Spec.ActorJWT.Audiences[0] != "http://models.test:8080" {
		t.Fatalf("gateway credential settings lost: %+v", model.Spec)
	}
	source.Annotations["agentos.dev/model-purpose"] = "embedding"
	model, err = config.Model(source)
	if err != nil {
		t.Fatal(err)
	}
	if model.Annotations["agentos.dev/model-purpose"] != "embedding" || model.Spec.OpenAI.APIFormat != nil {
		t.Fatalf("embedding model gained a language API format: %+v", model)
	}
	if model.Spec.TokenPassthrough != nil || model.Spec.ActorJWT == nil || model.Spec.ActorJWT.Audiences[0] != "http://models.test:8080" {
		t.Fatalf("embedding model left the runtime gateway credential: %+v", model.Spec)
	}
	delete(source.Annotations, "agentos.dev/model-config")
	source.Spec.Provider = ptr.To(agw.ModelProviderAnthropic)
	model, err = config.Model(source)
	if err != nil {
		t.Fatal(err)
	}
	if model.Spec.Provider != kagent.ModelProviderAnthropic || model.Spec.Anthropic.BaseURL != "http://models.test:8080" || model.Spec.OpenAI != nil {
		t.Fatalf("Anthropic protocol lost: %+v", model.Spec)
	}
	source.Annotations["agentos.dev/model-config"] = "{"
	if _, err := config.Model(source); err == nil {
		t.Fatal("invalid native settings accepted")
	}
}

func TestMCPSettings(t *testing.T) {
	config := Config(platform.PlatformGateway{
		Name: "gateway", MCPURL: "http://mcp.test:8080", DiscoveryServiceAccount: "gateway-discovery",
		ActorIssuer: "https://actors.test", ActorJWKSBackend: "actor-jwks",
	})
	source := &agw.AgentgatewayBackend{
		ObjectMeta: metav1.ObjectMeta{Name: "tools", Namespace: "team", Annotations: map[string]string{"agentos.dev/description": "Operations tools"}},
		Spec:       agw.AgentgatewayBackendSpec{MCP: &agw.MCPBackend{}},
	}
	objects, err := config.MCP(source)
	if err != nil {
		t.Fatal(err)
	}
	if len(objects) != 3 {
		t.Fatalf("expected connection, route and credential policy, got %d", len(objects))
	}
	for _, object := range objects {
		switch object := object.(type) {
		case *agw.AgentgatewayPolicy:
			transform := object.Spec.Traffic.Transformation
			if len(transform.Conditional) != 0 || transform.Request == nil || len(transform.Request.Remove) != 1 || transform.Request.Remove[0] != "authorization" {
				t.Fatalf("MCP initiator credential isolation lost: %+v", transform)
			}
		case *kagent.RemoteMCPServer:
			if object.Spec.URL != "http://mcp.test:8080/mcp/tools" || object.Spec.Description != "Operations tools" ||
				object.Spec.Timeout.Duration != 10*time.Minute || object.Spec.ActorJWT == nil || object.Spec.ActorJWT.Audiences[0] != "http://mcp.test:8080" || object.Spec.DiscoveryAuth == nil || object.Spec.DiscoveryAuth.ServiceAccount.ServiceAccountRef.Name != "gateway-discovery" || object.Spec.DiscoveryAuth.ServiceAccount.Audience != "agentos-mcp-discovery" {
				t.Fatalf("MCP settings lost: %+v", object)
			}
		}
	}
}
