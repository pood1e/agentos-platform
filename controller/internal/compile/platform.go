package compile

import (
	"fmt"
	"net/url"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func platformView(plan *platform.AccessPlan, environment platform.Environment, target platform.CompiledTarget, allowed []string, path string) []client.Object {
	gateway := plan.Spec.Platform
	identity := target.Engineer
	if target.Catalog {
		identity = "catalog"
	}
	backend := &agw.AgentgatewayBackend{ObjectMeta: metadata(plan.Namespace, target.Server), Spec: agw.AgentgatewayBackendSpec{
		MCP: &agw.MCPBackend{PrefixMode: agw.PrefixAlways, SessionRouting: agw.Stateless, Targets: []agw.McpTargetSelector{{Name: gw.SectionName(target.Service), Static: &agw.McpTarget{Host: ptr.To(environment.Gateway.Address), Port: environment.Gateway.NodePort, Path: ptr.To("/mcp/" + identity + "/" + target.Project), Protocol: ptr.To(agw.MCPProtocol("StreamableHTTP")), Policies: environmentTransport(environment, target)}}}},
		Policies: &agw.BackendFull{MCP: &agw.BackendMCP{Authorization: toolAuthorization(allowed, target.Catalog)},
			Transformation: &agw.Transformation{Request: &agw.Transform{Remove: []agw.HeaderName{"x-substrate-actor-token", "cookie", "x-forwarded-access-token"}}}},
	}}
	backend.Labels = map[string]string{"agentos.dev/environment": environment.Name, "agentos.dev/project": target.Project}
	origin := fmt.Sprintf("http://%s-mcp-gateway.%s.svc.cluster.local:8080", target.Service, plan.Namespace)
	title := environment.Titles[target.Project]
	if title == "" {
		title = target.Project
	}
	remote := Remote(plan.Namespace, target.Server, title, origin+path)
	policy := runtimePolicy(plan.Namespace, gateway, target.Server, origin)
	objects := []client.Object{backend, Route(plan.Namespace, gateway.Name, "http", "mcp-"+target.Server, path, target.Server, false), remote, policy}
	if target.Catalog {
		backend.Annotations = map[string]string{"agentos.dev/system-connection": "true"}
		remote.Spec.DiscoveryAuth = environment.DiscoveryAuth.DeepCopy()
		jwks, provider := catalogJWT(plan.Namespace, target.Server, environment)
		oauth, _ := identityBackend(plan.Namespace, target.Service+"-oauth", environment.DiscoveryAuth.OAuth2.TokenEndpoint, environment)
		objects = append(objects, jwks, oauth)
		policy.Spec.Traffic = &agw.Traffic{JWTAuthentication: &agw.JWTAuthentication{Mode: "Strict", PreserveToken: true, Providers: []agw.JWTProvider{provider}}, Authorization: authorization("has(jwt.azp) && jwt.azp == 'agentos-catalog' && request.method == 'POST' && (json(request.body).method in ['initialize','notifications/initialized','ping','tools/list'] || (json(request.body).method == 'resources/read' && json(request.body).params.uri.startsWith('ui://')))")}
	} else {
		backend.Labels["agentos.dev/engineer"], backend.Labels["agentos.dev/tool-access"] = target.Engineer, target.Access
		remote.Spec.ActorJWT = &kagent.ActorJWT{Audiences: []string{origin}}
		required := ""
		if target.Access == "write" {
			required = gateway.WriterRole
		}
		policy.Spec.Traffic.ExtAuth = &agw.ExtAuthOrConditional{ExtAuth: *RuntimeAuthorization(gateway.NativeAuthorityBackend, plan.Namespace, target.Server, required, true)}
		selected := agw.CELExpression("!has(extauthz.selection.tools) || mcp.tool.name in extauthz.selection.tools || ") + literal(target.Service+"_") + " + mcp.tool.name in extauthz.selection.tools"
		backend.Spec.Policies.MCP.Authorization.Policy.MatchExpressions = append(backend.Spec.Policies.MCP.Authorization.Policy.MatchExpressions, selected)
	}
	return objects
}

// RuntimeAuthorization resolves the Actor's pinned target and live initiator at kagent.
func RuntimeAuthorization(backend, namespace, server, scope string, subject bool) *agw.ExtAuth {
	path := "/authorize/runtime?server=" + url.QueryEscape(namespace+"/"+server)
	if scope != "" {
		path += "&scope=" + url.QueryEscape(scope)
	}
	if subject {
		path += "&credential=subject_token"
	}
	endpoint := agw.PolicyBackendEndpoint{BackendRef: &gw.BackendObjectReference{Group: ptr.To(gw.Group("agentgateway.dev")), Kind: ptr.To(gw.Kind("AgentgatewayBackend")), Name: gw.ObjectName(backend)}}
	http := &agw.AgentExtAuthHTTP{Path: ptr.To(literal(path)), AllowedRequestHeaders: []string{"x-substrate-actor-token"}, AddRequestHeaders: map[string]agw.CELExpression{"authorization": "request.headers['x-substrate-actor-token']"}, ResponseMetadata: map[string]agw.CELExpression{"selection": "json(response.body)", "scopes": "json(response.headers['x-kagent-scopes'])"}}
	if subject {
		http.AllowedResponseHeaders = []string{"authorization"}
	}
	return &agw.ExtAuth{PolicyBackendEndpoint: endpoint, FailureMode: agw.FailClosed, HTTP: http}
}

func catalogPolicy(plan *platform.AccessPlan, target platform.CompiledTarget, tools []string) *agw.AgentgatewayPolicy {
	policy := routePolicy(plan.Namespace, target.Service+"-engineer-auth", "mcp-"+target.Service)
	policy.Spec.Backend = &agw.BackendFull{MCP: &agw.BackendMCP{Authorization: toolAuthorization(tools, true)}}
	return policy
}

// runtimePolicy authenticates runtime requests for this exact gateway origin.
func runtimePolicy(namespace string, gateway *platform.PlatformGateway, server, audience string) *agw.AgentgatewayPolicy {
	policy := routePolicy(namespace, server+"-runtime-auth", "mcp-"+server)
	policy.Spec.Traffic = runtimeTraffic(gateway, audience)
	return policy
}

func runtimeTraffic(gateway *platform.PlatformGateway, audience string) *agw.Traffic {
	provider := agw.JWTProvider{Issuer: gateway.ActorIssuer, Audiences: []string{audience}, JWKS: agw.JWKS{Remote: &agw.RemoteJWKS{PolicyBackendEndpoint: agw.PolicyBackendEndpoint{BackendRef: &gw.BackendObjectReference{Group: ptr.To(gw.Group(agw.GroupVersion.Group)), Kind: ptr.To(gw.Kind("AgentgatewayBackend")), Name: gw.ObjectName(gateway.ActorJWKSBackend)}}, JwksPath: ptr.To("/openid/v1/jwks")}}, Validation: &agw.JWTValidationOptions{RequiredClaims: ptr.To([]agw.JWTClaim{"sub", "exp", "aud"})}}
	return &agw.Traffic{JWTAuthentication: &agw.JWTAuthentication{Mode: "Strict", PreserveToken: true, Providers: []agw.JWTProvider{provider}, Location: &agw.AuthorizationExtractionLocation{Expression: ptr.To(agw.CELExpression("'x-substrate-actor-token' in request.headers ? request.headers['x-substrate-actor-token'].replace('Bearer ', '') : ''"))}}, Authorization: authorization("has(jwt.iss) && jwt.iss == " + literal(gateway.ActorIssuer))}
}

func catalogJWT(namespace, server string, environment platform.Environment) (*agw.AgentgatewayBackend, agw.JWTProvider) {
	name := server + "-catalog-jwks"
	backend, path := identityBackend(namespace, name, environment.JWKSURL, environment)
	provider := agw.JWTProvider{Issuer: environment.Issuer, Audiences: []string{environment.Resource}, JWKS: agw.JWKS{Remote: &agw.RemoteJWKS{PolicyBackendEndpoint: backendReference(name), JwksPath: ptr.To(path)}}, Validation: &agw.JWTValidationOptions{RequiredClaims: ptr.To([]agw.JWTClaim{"sub", "exp", "aud"})}}
	return backend, provider
}
