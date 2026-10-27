package compile

import (
	"encoding/json"
	"time"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func literal(value any) agw.CELExpression {
	data, _ := json.Marshal(value)
	return agw.CELExpression(data)
}

func metadata(namespace, name string) metav1.ObjectMeta {
	return metav1.ObjectMeta{Namespace: namespace, Name: name}
}

func authorization(expression agw.CELExpression) *agw.Authorization {
	return &agw.Authorization{Action: agw.AuthorizationPolicyActionRequire, Policy: agw.AuthorizationPolicy{MatchExpressions: []agw.CELExpression{expression}}}
}

func toolAuthorization(tools []string, resources bool) *agw.Authorization {
	expression := agw.CELExpression("mcp.tool.name in ") + literal(names(tools))
	if resources {
		expression += " || (has(mcp.resource) && mcp.resource.name.startsWith('ui://'))"
	}
	return authorization(expression)
}

func endpoint(name string, port int32) agw.PolicyBackendEndpoint {
	return agw.PolicyBackendEndpoint{BackendRef: &gw.BackendObjectReference{Name: gw.ObjectName(name), Port: ptr.To(gw.PortNumber(port))}}
}

// Route binds a path to one native MCP backend.
func Route(namespace, gateway, section, name, path, backend string, exact bool) *gw.HTTPRoute {
	match := gw.PathMatchPathPrefix
	if exact {
		match = gw.PathMatchExact
	}
	return &gw.HTTPRoute{ObjectMeta: metadata(namespace, name), Spec: gw.HTTPRouteSpec{
		CommonRouteSpec: gw.CommonRouteSpec{ParentRefs: []gw.ParentReference{{Name: gw.ObjectName(gateway), SectionName: ptr.To(gw.SectionName(section))}}},
		Rules:           []gw.HTTPRouteRule{{Matches: []gw.HTTPRouteMatch{{Path: &gw.HTTPPathMatch{Type: &match, Value: &path}}}, BackendRefs: []gw.HTTPBackendRef{{BackendRef: gw.BackendRef{BackendObjectReference: gw.BackendObjectReference{Group: ptr.To(gw.Group("agentgateway.dev")), Kind: ptr.To(gw.Kind("AgentgatewayBackend")), Name: gw.ObjectName(backend)}}}}}},
	}}
}

// Remote exposes a gateway-backed MCP server to kagent discovery.
func Remote(namespace, name, description, url string) *kagent.RemoteMCPServer {
	return &kagent.RemoteMCPServer{ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name, Annotations: map[string]string{"agentos.dev/discovery-auth": "kubernetes"}}, Spec: kagent.RemoteMCPServerSpec{Description: description, Protocol: kagent.RemoteMCPServerProtocolStreamableHttp, URL: url, Timeout: &metav1.Duration{Duration: 10 * time.Minute}}}
}

func routePolicy(namespace, name, route string) *agw.AgentgatewayPolicy {
	return &agw.AgentgatewayPolicy{ObjectMeta: metadata(namespace, name), Spec: agw.AgentgatewayPolicySpec{TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{Group: "gateway.networking.k8s.io", Kind: "HTTPRoute", Name: gw.ObjectName(route)}}}}
}
