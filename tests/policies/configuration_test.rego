package main

import rego.v1

fixture_actor_provider := {"jwks": {"remote": {"jwksPath": "/openid/v1/jwks", "backendRef": {"group": "agentgateway.dev", "kind": "AgentgatewayBackend", "name": "actor-jwks"}}}}

fixture_actor_backend(tls) := {"kind": "AgentgatewayBackend", "metadata": {"name": "actor-jwks"}, "spec": {"static": {"host": "idp.ate-system.svc", "port": 443}, "policies": {"tls": tls}}}

test_native_actor_jwks_accepts_site_trust if {
	backend := fixture_actor_backend({"caCertificateRefs": [{"name": "site-ca", "kind": "ConfigMap"}]})
	actor_jwks_direct(fixture_actor_provider) with input as [{"contents": backend}]
}

test_native_actor_jwks_requires_ca if {
	backend := fixture_actor_backend({})
	not actor_jwks_direct(fixture_actor_provider) with input as [{"contents": backend}]
}

test_native_actor_jwks_requires_full_tls_verification if {
	every mode in ["Hostname", "All"] {
		backend := fixture_actor_backend({"caCertificateRefs": [{"name": "site-ca"}], "insecureSkipVerify": mode})
		not actor_jwks_direct(fixture_actor_provider) with input as [{"contents": backend}]
	}
}

test_native_actor_jwks_rejects_the_removed_proxy if {
	provider := {"jwks": {"remote": {"jwksPath": "/keys/actor", "backendRef": {"name": "dataplane", "port": 9092}}}}
	not actor_jwks_direct(provider) with input as []
}
