package main

import rego.v1

actor_jwks_direct(provider) if {
	remote := provider.jwks.remote
	remote.jwksPath == "/openid/v1/jwks"
	ref := remote.backendRef
	ref.group == "agentgateway.dev"
	ref.kind == "AgentgatewayBackend"
	some backend in objects
	backend.kind == "AgentgatewayBackend"
	backend.metadata.name == ref.name
	backend.spec.static.host != ""
	backend.spec.static.port > 0
	tls := backend.spec.policies.tls
	count(tls.caCertificateRefs) > 0
	object.get(tls, "insecureSkipVerify", "") == ""
}

deny contains sprintf("%s lacks direct verified Actor JWKS", [policy.metadata.name]) if {
	some policy in objects
	policy.kind == "AgentgatewayPolicy"
	some provider in policy.spec.traffic.jwtAuthentication.providers
	provider.issuer == api_environment.AGENTOS_ACTOR_ISSUER.value
	not actor_jwks_direct(provider)
}

role_of(deployment) := resource if {
	some resource in objects
	resource.kind == "Role"
	resource.metadata.name == deployment.spec.template.spec.serviceAccountName
}

configuration_permission(deployment, group, resource, verb) if {
	some rule in role_of(deployment).rules
	group in rule.apiGroups
	resource in rule.resources
	verb in rule.verbs
}

deny contains sprintf("%s cannot watch configuration %s/%s", [workload.metadata.name, group, resource]) if {
	some workload in [api, dataplane]
	some group, resources in {
		"api.kagent.dev": ["agents", "agenttemplates", "modelconfigs", "harnesses"],
		"agentgateway.dev": ["agentgatewaybackends"],
		"agentos.dev": ["accessplans"],
	}
	some resource in resources
	not configuration_permission(workload, group, resource, "watch")
}

deny contains sprintf("%s can mutate derived resource %s/%s", [workload.metadata.name, group, resource]) if {
	some workload in workloads
	some group, resources in {"api.kagent.dev": ["modelconfigs", "remotemcpservers"], "gateway.networking.k8s.io": ["httproutes"], "agentgateway.dev": ["agentgatewaypolicies"]}
	some resource in resources
	some verb in ["create", "update", "delete"]
	configuration_permission(workload, group, resource, verb)
}

deny contains sprintf("%s can write Kubernetes resources", [workload.metadata.name]) if {
	some workload in [dataplane]
	some rule in role_of(workload).rules
	some verb in rule.verbs
	not verb in {"get", "list", "watch"}
}
