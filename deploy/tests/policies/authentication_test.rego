package runtime_tests

import rego.v1

authentication_fixture := {
	"server": {"auth": {
		"mode": "oidc",
		"oidc": {"issuer": "https://identity.example.test", "audience": "agentos-api"},
		"serviceAccount": {"authority": "kubernetes"},
	}},
	"executionAuthorization": {
		"scopeClaim": "roles",
		"gatewayAudiences": ["http://agentos-gateway.agentos.svc.cluster.local:8080", "http://agentos-mcp-gateway.agentos.svc.cluster.local:8080"],
		"rules": [{"resourceType": "Session", "verbs": ["get"]}],
		"encryptionKeyFile": "/etc/kagent/execution/key",
		"oauth": {
			"tokenEndpoint": "https://identity.example.test/token",
			"clientId": "agentos-web",
			"clientSecretFile": "/etc/kagent/identity/client-secret",
		},
	},
}

test_native_authentication_accepts_site_identity if {
	native_authentication with native_config as authentication_fixture with kagent as {"config": authentication_fixture}
}

test_native_authentication_rejects_missing_identity if {
	not native_authentication with native_config as {} with kagent as {"config": authentication_fixture}
}

test_native_authentication_rejects_unverified_identity if {
	config := json.patch(authentication_fixture, [{"op": "replace", "path": "/server/auth/mode", "value": "trusted-proxy"}])
	not native_authentication with native_config as config with kagent as {"config": config}
}

test_native_authority_accepts_site_policy if {
	native_authority with native_config as authentication_fixture with kagent as {"config": authentication_fixture}
}

test_native_authority_rejects_empty_scope_rules if {
	config := json.patch(authentication_fixture, [{"op": "replace", "path": "/executionAuthorization/rules", "value": []}])
	not native_authority with native_config as config with kagent as {"config": config}
}

test_native_authority_rejects_empty_gateway_audiences if {
	config := json.patch(authentication_fixture, [{"op": "replace", "path": "/executionAuthorization/gatewayAudiences", "value": []}])
	not native_authority with native_config as config with kagent as {"config": config}
}

test_native_authority_rejects_scalar_gateway_audience if {
	config := json.patch(authentication_fixture, [{"op": "replace", "path": "/executionAuthorization/gatewayAudiences", "value": "http://gateway.example.test"}])
	not native_authority with native_config as config with kagent as {"config": config}
}

test_native_authority_rejects_insecure_renewal if {
	config := json.patch(authentication_fixture, [{"op": "replace", "path": "/executionAuthorization/oauth/tokenEndpoint", "value": "http://identity.example.test/token"}])
	not native_authority with native_config as config with kagent as {"config": config}
}

test_native_invocation_accepts_kubernetes_identity if {
	native_invocation_authentication with native_config as authentication_fixture
}

test_native_invocation_rejects_missing_verifier if {
	config := json.patch(authentication_fixture, [{"op": "remove", "path": "/server/auth/serviceAccount"}])
	not native_invocation_authentication with native_config as config
}
