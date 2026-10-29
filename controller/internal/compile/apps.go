package compile

import (
	"fmt"
	"net/url"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func appViews(plan *platform.AccessPlan, targets []platform.CompiledTarget) ([]client.Object, error) {
	gateway := plan.Spec.Platform
	if gateway == nil || gateway.AppAuthorityBackend == "" && gateway.AppJWTProvider == nil {
		return nil, nil
	}
	provider := gateway.AppJWTProvider
	if gateway.Name == "" || gateway.AppAuthorityBackend == "" || provider == nil || provider.Issuer == "" || len(provider.Audiences) == 0 || provider.JWKS.Remote == nil {
		return nil, fmt.Errorf("MCP Apps require a gateway, viewer authority backend and JWT issuer, audience and remote JWKS")
	}
	issuer, err := url.Parse(provider.Issuer)
	if err != nil || issuer.Scheme != "https" || issuer.Hostname() == "" || issuer.User != nil || issuer.RawQuery != "" || issuer.Fragment != "" {
		return nil, fmt.Errorf("MCP Apps require an HTTPS viewer issuer")
	}
	for _, audience := range provider.Audiences {
		if audience == "" {
			return nil, fmt.Errorf("MCP Apps require nonempty viewer audiences")
		}
	}
	var resources []client.Object
	for _, target := range targets {
		var read []string
		for _, tool := range target.Tools {
			if !tool.Write {
				read = append(read, tool.Name)
			}
		}
		if len(read) == 0 {
			continue
		}
		name := "apps-mcp-" + target.Server
		route := Route(plan.Namespace, gateway.Name, "http", name, "/apps/mcp/"+target.Server, target.Server, true)
		policy := routePolicy(plan.Namespace, name, name)
		viewer := provider.DeepCopy()
		viewer.Validation = &agw.JWTValidationOptions{RequiredClaims: ptr.To([]agw.JWTClaim{"sub", "exp", "aud"})}
		policy.Spec.Traffic = &agw.Traffic{
			JWTAuthentication: &agw.JWTAuthentication{
				Mode: "Strict", PreserveToken: true, Providers: []agw.JWTProvider{*viewer},
				Location: &agw.AuthorizationExtractionLocation{Expression: ptr.To(agw.CELExpression("'authorization' in request.headers ? request.headers['authorization'].replace('Bearer ', '') : ''"))},
			},
			ExtAuth: &agw.ExtAuthOrConditional{ExtAuth: agw.ExtAuth{
				PolicyBackendEndpoint: backendReference(gateway.AppAuthorityBackend), FailureMode: agw.FailClosed,
				HTTP: &agw.AgentExtAuthHTTP{
					Path:                  ptr.To(literal("/authorize/mcp-app?server=" + url.QueryEscape(target.Server))),
					AllowedRequestHeaders: []string{"authorization", "x-agentos-app-reference"},
					ResponseMetadata:      map[string]agw.CELExpression{"selection": "json(response.body).selection"},
				},
			}},
			Authorization: authorization(appRequest(target.Server)),
			Transformation: &agw.TransformationOrConditional{Request: &agw.Transform{
				Remove: []agw.HeaderName{"x-substrate-actor-token", "x-agentos-app-reference", "cookie", "x-forwarded-access-token"},
			}},
		}
		policy.Spec.Backend = &agw.BackendFull{MCP: &agw.BackendMCP{Authorization: authorization(appTools(target.Server, read))}}
		resources = append(resources, route, policy)
	}
	return resources, nil
}

func appSelection(server string) agw.CELExpression {
	return "has(extauthz.selection) && extauthz.selection.server == " + literal(server) + " && has(extauthz.selection.tools)"
}

func appRequest(server string) agw.CELExpression {
	return appSelection(server) + " && (request.method in ['GET','DELETE'] || (request.method == 'POST' && " +
		"(json(request.body).method in ['initialize','notifications/initialized','ping'] || " +
		"(json(request.body).method == 'tools/call' && json(request.body).params.name in extauthz.selection.tools))))"
}

func appTools(server string, read []string) agw.CELExpression {
	return appSelection(server) + " && has(mcp.tool) && " +
		"(mcp.tool.name in extauthz.selection.tools || mcp.tool.target + '_' + mcp.tool.name in extauthz.selection.tools) && " +
		"(mcp.tool.name in " + literal(read) + " || mcp.tool.target + '_' + mcp.tool.name in " + literal(read) +
		" || " + literal(read) + ".exists(name, mcp.tool.name == mcp.tool.target + '_' + name))"
}
