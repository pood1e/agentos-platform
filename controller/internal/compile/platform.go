package compile

import (
	"fmt"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func platformView(plan *platform.AccessPlan, environment platform.Environment, target platform.CompiledTarget, allowed []string, path string) []client.Object {
	platformGateway := plan.Spec.Platform
	identity := target.Engineer
	if target.Catalog {
		identity = "catalog"
	}
	backend := &agw.AgentgatewayBackend{ObjectMeta: metadata(plan.Namespace, target.Server), Spec: agw.AgentgatewayBackendSpec{
		MCP: &agw.MCPBackend{PrefixMode: agw.PrefixAlways, Targets: []agw.McpTargetSelector{{Name: gw.SectionName(target.Service), Static: &agw.McpTarget{Host: ptr.To(environment.Gateway.Address), Port: environment.Gateway.NodePort, Path: ptr.To("/mcp/" + identity + "/" + target.Project), Protocol: ptr.To(agw.MCPProtocol("StreamableHTTP"))}}}},
		Policies: &agw.BackendFull{BackendSimple: agw.BackendSimple{HTTP: &agw.BackendHTTP{RequestTimeout: &agw.Duration{Duration: 10 * time.Minute}}, TLS: &agw.BackendTLS{Sni: ptr.To(environment.Gateway.Host), CACertificateRefs: []agw.LocalCACertificateRef{{Name: gw.ObjectName(environment.Name + "-gateway-ca"), Kind: "ConfigMap"}}, VerifySubjectAltNames: []string{environment.Gateway.Host}}},
			ExtAuth: &agw.ExtAuth{PolicyBackendEndpoint: endpoint(platformGateway.Dataplane, 9090), FailureMode: agw.FailClosed, HTTP: &agw.AgentExtAuthHTTP{Path: ptr.To(agw.CELExpression("'/authorize/environment'")), Body: ptr.To(agw.CELExpression(fmt.Sprintf("{'serviceNames': [%s], 'metadataContext': {'environment': %s, 'identity': %s, 'discovery': !('x-substrate-actor-token' in request.headers)}}", literal(target.Service), literal(environment.Name), literal(identity)))), AllowedRequestHeaders: []string{"x-substrate-actor-token", "authorization"}, AllowedResponseHeaders: []string{"authorization"}}},
			MCP:     &agw.BackendMCP{Guardrails: &agw.MCPGuardrails{Processors: []agw.MCPGuardrailsProcessor{{Methods: map[string]agw.MCPMethodPhase{"*": agw.MCPMethodPhaseFull}, Remote: &agw.MCPGuardrailsRemote{PolicyBackendEndpoint: endpoint(platformGateway.Dataplane, 9090), FailureMode: agw.FailClosed, AllowedRequestHeaders: []agw.HeaderName{"x-substrate-actor-token"}, Metadata: map[string]agw.CELExpression{"execution": "true", "environment": literal(environment.Name), "identity": literal(identity)}}}}}},
		},
	}}
	backend.Labels = map[string]string{"agentos.dev/environment": environment.Name, "agentos.dev/project": target.Project}
	if target.Catalog {
		backend.Annotations = map[string]string{"agentos.dev/system-connection": "true"}
	} else {
		backend.Labels["agentos.dev/engineer"], backend.Labels["agentos.dev/tool-access"] = target.Engineer, target.Access
		backend.Spec.Policies.MCP.Authorization = toolAuthorization(allowed, false)
	}
	route := Route(plan.Namespace, platformGateway.Name, "http", "mcp-"+target.Server, path, target.Server, false)
	route.Labels = map[string]string{"agentos.dev/mcp-source": target.Service}
	url := fmt.Sprintf("http://%s-mcp-gateway.%s.svc.cluster.local:8080", target.Service, plan.Namespace)
	title := environment.Titles[target.Project]
	if title == "" {
		title = target.Project
	}
	if !target.Catalog {
		title += "; " + target.Engineer
	}
	return []client.Object{backend, route, Remote(plan.Namespace, target.Server, title, url+path), RuntimePolicy(plan.Namespace, platformGateway, target.Server, target.Service, url, target.Catalog)}
}

func catalogPolicy(plan *platform.AccessPlan, target platform.CompiledTarget, tools []string) *agw.AgentgatewayPolicy {
	policy := routePolicy(plan.Namespace, target.Service+"-engineer-auth", "mcp-"+target.Service)
	policy.Spec.Backend = &agw.BackendFull{MCP: &agw.BackendMCP{Authorization: toolAuthorization(tools, true)}}
	return policy
}

// RuntimePolicy binds Actor validation to a specific route and audience.
func RuntimePolicy(namespace string, gateway *platform.PlatformGateway, server, service, audience string, catalog bool) *agw.AgentgatewayPolicy {
	policy := routePolicy(namespace, server+"-runtime-auth", "mcp-"+server)
	catalogPath := ""
	if catalog {
		catalogPath = "/mcp/" + service
	}
	policy.Spec.Traffic = RuntimeTraffic(gateway, audience, catalogPath)
	return policy
}

// RuntimeTraffic supplies the platform's Actor and discovery authentication policy.
func RuntimeTraffic(gateway *platform.PlatformGateway, audience, catalogPath string) *agw.Traffic {
	expression := agw.CELExpression("(has(jwt.iss) && jwt.iss == ") + literal(gateway.ActorIssuer) + ")"
	if catalogPath != "" {
		expression = "(request.path != " + literal(catalogPath) + " && " + expression + ")"
	}
	expression += " || (!('x-substrate-actor-token' in request.headers) && 'authorization' in request.headers)"
	provider := agw.JWTProvider{
		Issuer: gateway.ActorIssuer, Audiences: []string{audience},
		JWKS: agw.JWKS{Remote: &agw.RemoteJWKS{
			PolicyBackendEndpoint: agw.PolicyBackendEndpoint{BackendRef: &gw.BackendObjectReference{
				Group: ptr.To(gw.Group(agw.GroupVersion.Group)), Kind: ptr.To(gw.Kind("AgentgatewayBackend")),
				Name: gw.ObjectName(gateway.ActorJWKSBackend),
			}},
			JwksPath: ptr.To("/openid/v1/jwks"),
		}},
		Validation: &agw.JWTValidationOptions{RequiredClaims: ptr.To([]agw.JWTClaim{"sub", "exp", "aud"})},
	}
	return &agw.Traffic{
		JWTAuthentication: &agw.JWTAuthentication{
			Mode: "Permissive", PreserveToken: true, Providers: []agw.JWTProvider{provider},
			Location: &agw.AuthorizationExtractionLocation{Expression: ptr.To(agw.CELExpression("'x-substrate-actor-token' in request.headers ? request.headers['x-substrate-actor-token'].replace('Bearer ', '') : ''"))},
		},
		Authorization: authorization(expression),
	}
}
