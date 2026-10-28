package compile

import (
	"fmt"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func serverPolicy(plan *platform.AccessPlan, server string, tools []platform.CompiledTool) (*agw.AgentgatewayPolicy, error) {
	gateway := plan.Spec.Platform
	if gateway == nil || gateway.WriterRole == "" || gateway.DiscoveryServiceAccount == "" {
		return nil, fmt.Errorf("server %s requires a writer role and discovery ServiceAccount", server)
	}
	read, write := []string{}, []string{}
	for _, tool := range tools {
		if tool.Write {
			write = append(write, tool.Name)
		} else {
			read = append(read, tool.Name)
		}
	}
	discovery := "system:serviceaccount:" + plan.Namespace + ":" + gateway.DiscoveryServiceAccount
	expression := agw.CELExpression("jwt.sub == ") + literal(discovery) +
		" || (has(extauthz.selection) && (!has(extauthz.selection.tools) || mcp.tool.name in extauthz.selection.tools) && (mcp.tool.name in " + literal(read) +
		" || (has(extauthz.scopes) && " + literal(gateway.WriterRole) + " in extauthz.scopes && mcp.tool.name in " + literal(write) + ")))"
	return &agw.AgentgatewayPolicy{ObjectMeta: metadata(plan.Namespace, server+"-tool-access"), Spec: agw.AgentgatewayPolicySpec{
		TargetRefs: []agw.LocalPolicyTargetReferenceWithSectionName{{Group: "agentgateway.dev", Kind: "AgentgatewayBackend", Name: gw.ObjectName(server)}},
		Backend:    &agw.BackendFull{MCP: &agw.BackendMCP{Authorization: authorization(expression)}},
	}}, nil
}
