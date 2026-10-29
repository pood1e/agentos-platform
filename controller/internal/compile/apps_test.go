package compile

import (
	"reflect"
	"slices"
	"testing"

	"cel.dev/cel-go/cel"
	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	"k8s.io/utils/ptr"
	gw "sigs.k8s.io/gateway-api/apis/v1"
)

func appsPlan(t *testing.T) *platform.AccessPlan {
	t.Helper()
	p := planFor(t, "approval")
	p.Spec.Platform = &platform.PlatformGateway{Name: "gateway", AppAuthorityBackend: "app-authority", AppJWTProvider: &agw.JWTProvider{Issuer: "https://identity.test", Audiences: []string{"platform"}, JWKS: agw.JWKS{Remote: &agw.RemoteJWKS{PolicyBackendEndpoint: backendReference("viewer-jwks"), JwksPath: ptr.To("/keys")}}}}
	return p
}

func TestAppsUseCanonicalBackendAndViewerAuthority(t *testing.T) {
	p := appsPlan(t)
	before := p.DeepCopy()
	r, err := Plan(p)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(p, before) {
		t.Fatal("compilation mutated viewer trust")
	}
	routes, policies := 0, 0
	for _, o := range r.Resources {
		switch o := o.(type) {
		case *gw.HTTPRoute:
			routes++
			ref := o.Spec.Rules[0].BackendRefs[0].Name
			match := o.Spec.Rules[0].Matches[0].Path
			if *match.Type != gw.PathMatchExact || *match.Value != "/apps/mcp/"+string(ref) {
				t.Fatalf("route is not a canonical exact view: %+v", o.Spec)
			}
		case *agw.AgentgatewayPolicy:
			policies++
			traffic := o.Spec.Traffic
			if traffic.JWTAuthentication.Mode != "Strict" || traffic.JWTAuthentication.Providers[0].Issuer != "https://identity.test" || len(traffic.JWTAuthentication.Providers) != 1 {
				t.Fatal("viewer JWT trust was lost")
			}
			if got := *traffic.JWTAuthentication.Location.Expression; got != "'authorization' in request.headers ? request.headers['authorization'].replace('Bearer ', '') : ''" {
				t.Fatalf("viewer identity extraction: %s", got)
			}
			auth := traffic.ExtAuth
			if auth.FailureMode != agw.FailClosed || auth.BackendRef.Name != "app-authority" || !reflect.DeepEqual(auth.HTTP.AllowedRequestHeaders, []string{"authorization", "x-agentos-app-reference"}) || len(auth.HTTP.AllowedResponseHeaders) != 0 || len(auth.HTTP.AddRequestHeaders) != 0 {
				t.Fatalf("extAuth credential boundary: %+v", auth)
			}
			if auth.HTTP.ResponseMetadata["selection"] != "json(response.body).selection" {
				t.Fatal("missing native selection")
			}
			if slices.Contains(traffic.Transformation.Request.Remove, agw.HeaderName("authorization")) {
				t.Fatal("viewer credential was stripped before native backend token exchange")
			}
			for _, header := range []agw.HeaderName{"x-substrate-actor-token", "cookie", "x-agentos-app-reference"} {
				if !slices.Contains(traffic.Transformation.Request.Remove, header) {
					t.Fatalf("header %s can reach the MCP backend", header)
				}
			}
		default:
			t.Fatalf("App view introduced %T instead of reusing its backend", o)
		}
	}
	if routes != 4 || policies != routes {
		t.Fatalf("got %d routes/%d policies; write-only views must be absent", routes, policies)
	}
}

func TestAppsRequireCompleteViewerTrust(t *testing.T) {
	for _, modify := range []func(*platform.PlatformGateway){
		func(g *platform.PlatformGateway) { g.AppAuthorityBackend = "" },
		func(g *platform.PlatformGateway) { g.AppJWTProvider = nil },
		func(g *platform.PlatformGateway) { g.AppJWTProvider.Audiences = nil },
		func(g *platform.PlatformGateway) { g.AppJWTProvider.JWKS.Remote = nil },
		func(g *platform.PlatformGateway) { g.AppJWTProvider.Issuer = "http://identity.test" },
		func(g *platform.PlatformGateway) { g.AppJWTProvider.Audiences = []string{""} },
	} {
		p := appsPlan(t)
		modify(p.Spec.Platform)
		if _, err := Plan(p); err == nil {
			t.Fatal("incomplete App trust accepted")
		}
	}
	p := appsPlan(t)
	p.Spec.Platform.AppAuthorityBackend = ""
	p.Spec.Platform.AppJWTProvider = nil
	r, err := Plan(p)
	if err != nil || len(r.Resources) != 0 {
		t.Fatalf("disabled Apps altered ordinary connections: %+v, %v", r.Resources, err)
	}
}

func TestAppsToolSelectionIsReadOnlyAndSourceBound(t *testing.T) {
	env, err := cel.NewEnv(cel.Variable("mcp", cel.DynType), cel.Variable("extauthz", cel.DynType))
	if err != nil {
		t.Fatal(err)
	}
	ast, issues := env.Compile(string(appTools("canonical", []string{"read"})))
	if issues.Err() != nil {
		t.Fatal(issues.Err())
	}
	program, err := env.Program(ast)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, server, tool string
		selected           []string
		want               bool
	}{
		{"raw tool", "canonical", "read", []string{"canonical_read"}, true},
		{"prefixed tool", "canonical", "canonical_read", []string{"canonical_read"}, true},
		{"write tool", "canonical", "write", []string{"canonical_write"}, false},
		{"other source", "other", "read", []string{"canonical_read"}, false},
		{"unselected tool", "canonical", "read", []string{"canonical_other"}, false},
		{"empty selection", "canonical", "read", []string{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, _, err := program.Eval(map[string]any{"mcp": map[string]any{"tool": map[string]any{"name": tc.tool, "target": "canonical"}}, "extauthz": map[string]any{"selection": map[string]any{"server": tc.server, "tools": tc.selected}}})
			if err != nil || v.Value() != tc.want {
				t.Fatalf("got %v (%v), want %v", v, err, tc.want)
			}
		})
	}
}

func TestAppsBackendPolicyKeepsRuntimeAndReadBoundaries(t *testing.T) {
	p := appsPlan(t)
	p.Spec.Platform.WriterRole = "writer"
	p.Spec.Platform.DiscoveryServiceAccount = "discovery"
	policy, err := serverPolicy(p, "canonical", []platform.CompiledTool{{Name: "read"}, {Name: "write", Write: true}})
	if err != nil {
		t.Fatal(err)
	}
	env, err := cel.NewEnv(cel.Variable("request", cel.DynType), cel.Variable("jwt", cel.DynType), cel.Variable("mcp", cel.DynType), cel.Variable("extauthz", cel.DynType))
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
	for _, tc := range []struct {
		name, path, tool, selected string
		want                       bool
	}{
		{"selected App read", "/apps/mcp/canonical", "read", "canonical_read", true},
		{"selected App write", "/apps/mcp/canonical", "write", "canonical_write", false},
		{"unselected App read", "/apps/mcp/canonical", "read", "canonical_other", false},
		{"runtime read unchanged", "/mcp/canonical", "read", "read", true},
		{"runtime write unchanged", "/mcp/canonical", "write", "write", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, _, err := program.Eval(map[string]any{
				"request": map[string]any{"path": tc.path}, "jwt": map[string]any{"sub": "viewer"},
				"mcp":      map[string]any{"tool": map[string]any{"name": tc.tool, "target": "canonical"}},
				"extauthz": map[string]any{"selection": map[string]any{"server": "canonical", "tools": []string{tc.selected}}, "scopes": []string{"writer"}},
			})
			if err != nil || v.Value() != tc.want {
				t.Fatalf("got %v (%v), want %v", v, err, tc.want)
			}
		})
	}
}
