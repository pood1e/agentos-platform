package compile

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func environmentView(plan *platform.AccessPlan, environment platform.Environment, project string, identity platform.Identity, access platform.Access, tools []string) ([]client.Object, error) {
	connector, ok := plan.Spec.Connectors[project]
	if !ok {
		return nil, fmt.Errorf("connector %s is required", project)
	}
	var targets []agw.McpTargetSelector
	oauth := 0
	for _, target := range connector.Targets {
		if target.Auth != nil && target.Auth.OAuthTokenExchange != nil {
			oauth++
		}
		if target.Access != nil && !slices.Contains(target.Access, access) {
			continue
		}
		configuration := target.McpTarget.DeepCopy()
		if configuration.Protocol == nil {
			configuration.Protocol = ptr.To(agw.MCPProtocol("StreamableHTTP"))
		}
		if target.Auth != nil {
			data, err := json.Marshal(target.Auth)
			if err != nil {
				return nil, err
			}
			var auth agw.BackendAuth
			for _, variable := range [][2]string{{"<identity>", identity.Name}, {"<environment>", environment.Name}, {"<issuer>", environment.Issuer}} {
				key, _ := json.Marshal(variable[0])
				value, _ := json.Marshal(variable[1])
				data = bytes.ReplaceAll(data, key[1:len(key)-1], value[1:len(value)-1])
			}
			if err := json.Unmarshal(data, &auth); err != nil {
				return nil, err
			}
			if configuration.Policies == nil {
				configuration.Policies = &agw.BackendSimple{}
			}
			configuration.Policies.Auth = &auth
		}
		name := target.Name
		if name == "" {
			name = project
		}
		targets = append(targets, agw.McpTargetSelector{Name: gw.SectionName(name), Static: configuration})
	}
	if oauth != 0 && oauth != len(connector.Targets) {
		return nil, fmt.Errorf("connector %s mixes credential boundaries", project)
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("connector %s has no targets for %s", project, identity.Name)
	}
	name := project + "-" + identity.Name
	backend := &agw.AgentgatewayBackend{ObjectMeta: metadata(plan.Namespace, name), Spec: agw.AgentgatewayBackendSpec{MCP: &agw.MCPBackend{PrefixMode: agw.PrefixNever, SessionRouting: agw.Stateless, Targets: targets}, Policies: &agw.BackendFull{MCP: &agw.BackendMCP{Authorization: toolAuthorization(tools, identity.Name == "catalog")}}}}
	backend.Labels = map[string]string{"agentos.dev/component": "environment-tool", "agentos.dev/project": project}
	route := Route(plan.Namespace, "mcp-gateway", "https", name, "/mcp/"+identity.Name+"/"+project, name, true)
	remove := []string{"x-substrate-actor-token"}
	if oauth == 0 {
		remove = append(remove, "authorization")
	}
	route.Spec.Rules[0].Filters = []gw.HTTPRouteFilter{{Type: gw.HTTPRouteFilterRequestHeaderModifier, RequestHeaderModifier: &gw.HTTPHeaderFilter{Remove: remove}}}
	policy := routePolicy(plan.Namespace, name+"-identity", name)
	policy.Spec.Traffic = &agw.Traffic{Authorization: authorization("has(jwt.azp) && jwt.azp == " + literal("agentos-"+identity.Name))}
	return []client.Object{backend, route, policy}, nil
}
