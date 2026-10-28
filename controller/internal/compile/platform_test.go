package compile

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	agw "github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
	kagent "github.com/kagent-dev/kagent/go/api/v1alpha3"
	platform "github.com/pood1e/agentos-platform/controller/api/v1alpha1"
	corev1 "k8s.io/api/core/v1"
)

func gatewayPlan(t *testing.T) *platform.AccessPlan {
	t.Helper()
	plan := planFor(t, "approval")
	plan.Spec.Platform = &platform.PlatformGateway{Name: "gateway", ActorIssuer: "https://actors.test", ActorJWKSBackend: "actor-jwks", NativeAuthorityBackend: "native-authority", WriterRole: "writer"}
	source := `{"name":"lab","governance":"approval","issuer":"https://idp.test","resource":"https://tools.test/mcp","jwksURL":"https://idp.test/keys","gateway":{"address":"192.0.2.1","host":"tools.test","nodePort":443},"discoveryAuth":{"oauth2":{"tokenEndpoint":"https://idp.test/token","clientId":"agentos-catalog","clientSecretRef":{"name":"catalog","key":"client-secret"}}}}`
	if err := json.Unmarshal([]byte(source), &plan.Spec.Environments[0]); err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestEnvironmentGatewayNativeAuthority(t *testing.T) {
	plan := gatewayPlan(t)
	before := plan.DeepCopy()
	result, err := Plan(plan)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Spec.Environments[0].DiscoveryAuth.OAuth2.ClientID != before.Spec.Environments[0].DiscoveryAuth.OAuth2.ClientID {
		t.Fatal("compilation mutated discovery credentials")
	}
	for _, object := range result.Resources {
		policy, ok := object.(*agw.AgentgatewayPolicy)
		if !ok || !strings.HasSuffix(policy.Name, "-runtime-auth") {
			continue
		}
		if policy.Name == "lab-ops-runtime-auth" {
			if policy.Spec.Traffic.ExtAuth != nil || policy.Spec.Traffic.JWTAuthentication.Providers[0].Issuer != "https://idp.test" {
				t.Fatal("catalog discovery did not retain its independent IdP boundary")
			}
			continue
		}
		authority := policy.Spec.Traffic.ExtAuth
		if authority == nil || authority.HTTP == nil || !strings.Contains(string(*authority.HTTP.Path), "credential=subject_token") {
			t.Fatalf("%s lacks its native subject-token callback", policy.Name)
		}
		write := strings.Contains(policy.Name, "-changes-")
		if strings.Contains(string(*authority.HTTP.Path), "scope=writer") != write {
			t.Fatalf("%s has an incorrect write scope boundary", policy.Name)
		}
	}
}

func TestEnvironmentGatewayCredentialIsolation(t *testing.T) {
	plan := gatewayPlan(t)
	plan.Spec.Environments[0].DiscoveryAuth.OAuth2.CACertificateRef = &corev1.ConfigMapKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: "identity-ca"}, Key: "issuer.pem",
	}
	result, err := Plan(plan)
	if err != nil {
		t.Fatal(err)
	}
	var runtime, catalog, issuer int
	for _, object := range result.Resources {
		switch object := object.(type) {
		case *kagent.RemoteMCPServer:
			if object.Spec.DiscoveryAuth != nil && object.Spec.DiscoveryAuth.OAuth2 != nil && object.Spec.DiscoveryAuth.OAuth2.CACertificateRef.Name != "identity-ca" {
				t.Fatal("catalog discovery lost its IdP CA")
			}
		case *agw.AgentgatewayBackend:
			if object.Spec.Static != nil {
				issuer++
				ca := object.Spec.Policies.TLS.CACertificateRefs
				if len(ca) != 1 || ca[0].Name != "identity-ca" || ca[0].Key != "issuer.pem" {
					t.Fatalf("%s trusts the gateway CA instead of its IdP: %+v", object.Name, ca)
				}
				continue
			}
			if object.Spec.MCP == nil {
				continue
			}
			transport := object.Spec.MCP.Targets[0].Static.Policies
			if transport.TLS.CACertificateRefs[0].Name != "lab-gateway-ca" || transport.TLS.VerifySubjectAltNames[0] != "tools.test" {
				t.Fatalf("%s lost its environment TLS identity", object.Name)
			}
			removed := object.Spec.Policies.Transformation.Request.Remove
			if !slices.Contains(removed, "x-substrate-actor-token") || !slices.Contains(removed, "cookie") {
				t.Fatalf("%s forwards runtime credentials: %v", object.Name, removed)
			}
			engineer := object.Labels["agentos.dev/engineer"]
			if engineer == "" {
				catalog++
				if transport.Auth != nil {
					t.Fatal("catalog discovery gained runtime token exchange")
				}
				continue
			}
			runtime++
			if transport.Auth == nil || transport.Auth.OAuthTokenExchange == nil {
				t.Fatalf("%s lacks native token exchange", object.Name)
			}
			exchange := transport.Auth.OAuthTokenExchange
			if *exchange.Path != "/token" || exchange.Audiences[0] != "https://tools.test/mcp" || exchange.ClientAuth.ClientID != "agentos-"+engineer || string(exchange.ClientAuth.SecretRef.Name) != "lab-"+engineer || exchange.BackendRef.Name != "lab-ops-oauth" {
				t.Fatalf("%s has incorrect exchange credentials: %+v", object.Name, exchange)
			}
		}
	}
	if runtime == 0 || catalog == 0 || issuer != 2 {
		t.Fatalf("incomplete gateway coverage: runtime=%d catalog=%d issuer=%d", runtime, catalog, issuer)
	}
}

func TestEnvironmentGatewayRejectsIncompleteTrust(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		mutate func(*platform.AccessPlan)
	}{
		{"platform", func(p *platform.AccessPlan) { p.Spec.Platform = nil }},
		{"writer role", func(p *platform.AccessPlan) { p.Spec.Platform.WriterRole = "" }},
		{"authority backend", func(p *platform.AccessPlan) { p.Spec.Platform.NativeAuthorityBackend = "" }},
		{"issuer", func(p *platform.AccessPlan) { p.Spec.Environments[0].Issuer = "" }},
		{"insecure JWKS", func(p *platform.AccessPlan) { p.Spec.Environments[0].JWKSURL = "http://idp.test/keys" }},
		{"resource", func(p *platform.AccessPlan) { p.Spec.Environments[0].Resource = "" }},
		{"port", func(p *platform.AccessPlan) { p.Spec.Environments[0].Gateway.NodePort = 0 }},
		{"discovery", func(p *platform.AccessPlan) { p.Spec.Environments[0].DiscoveryAuth = nil }},
		{"client secret", func(p *platform.AccessPlan) { p.Spec.Environments[0].DiscoveryAuth.OAuth2.ClientSecretRef.Key = "" }},
		{"token endpoint", func(p *platform.AccessPlan) {
			p.Spec.Environments[0].DiscoveryAuth.OAuth2.TokenEndpoint = "https://user:secret@idp.test/token"
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			plan := gatewayPlan(t)
			scenario.mutate(plan)
			if _, err := Plan(plan); err == nil {
				t.Fatal("incomplete gateway trust compiled")
			}
		})
	}
}
