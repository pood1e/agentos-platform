package compile

import (
	"testing"

	"cel.dev/cel-go/cel"
	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
)

func TestServerToolsUseSelectedNamesAndLiveScopes(t *testing.T) {
	plan := &platform.AccessPlan{Spec: platform.AccessPlanSpec{
		Mode: "platform", Platform: &platform.PlatformGateway{WriterRole: "writer", DiscoveryServiceAccount: "discovery"},
		Servers: map[string]platform.Toolset{"tools": {ReadOnly: []string{"read"}, Write: []string{"write"}}},
	}}
	result, err := Plan(plan)
	if err != nil {
		t.Fatal(err)
	}
	policy := result.Resources[0].(*agw.AgentgatewayPolicy)
	if target := policy.Spec.TargetRefs[0]; target.Kind != "AgentgatewayBackend" || target.Name != "tools" {
		t.Fatalf("policy targets a different backend: %+v", target)
	}
	env, err := cel.NewEnv(cel.Variable("jwt", cel.DynType), cel.Variable("mcp", cel.DynType), cel.Variable("extauthz", cel.DynType))
	if err != nil {
		t.Fatal(err)
	}
	ast, issues := env.Compile(string(policy.Spec.Backend.MCP.Authorization.Policy.MatchExpressions[0]))
	if issues.Err() != nil {
		t.Fatal(issues.Err())
	}
	program, err := env.Program(ast)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, tool string
		scopes     []string
		selected   []string
		allowed    bool
	}{
		{"read-only read", "read", []string{"reader"}, []string{"read", "write"}, true},
		{"read-only write", "write", []string{"reader"}, []string{"read", "write"}, false},
		{"writer write", "write", []string{"reader", "writer"}, []string{"read", "write"}, true},
		{"unselected write", "write", []string{"writer"}, []string{"read"}, false},
		{"unknown tool", "unknown", []string{"writer"}, []string{"unknown"}, false},
		{"empty scopes", "write", []string{}, []string{"write"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, _, err := program.Eval(map[string]any{
				"jwt": map[string]any{"sub": "actor"}, "mcp": map[string]any{"tool": map[string]any{"name": test.tool}},
				"extauthz": map[string]any{"scopes": test.scopes, "selection": map[string]any{"tools": test.selected}},
			})
			if err != nil || value.Value() != test.allowed {
				t.Fatalf("authorization=%v, error=%v, want %t", value, err, test.allowed)
			}
		})
	}
}
