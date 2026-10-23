package environment_tests

import rego.v1

resources := [item.contents | some item in input; is_object(item.contents)]

has_resource(kind, name) if {
	some resource in resources
	resource.kind == kind
	resource.metadata.name == name
}

deny contains sprintf("%s/%s has conflicting resource ownership", [resource.kind, resource.metadata.name]) if {
	some resource in resources
	count(object.get(resource.metadata, "ownerReferences", [])) > 0
}

deny contains "editable AgentTemplates belong to the platform" if {
	some resource in resources
	resource.kind == "AgentTemplate"
}

deny contains sprintf("%s lacks its matching RemoteMCPServer or route", [name]) if {
	some resource in resources
	resource.kind == "AgentgatewayBackend"
	object.get(resource.metadata.labels, "agentos.dev/environment", "") != ""
	name := resource.metadata.name
	not has_resource("RemoteMCPServer", name)
}

deny contains sprintf("%s lacks its matching HTTPRoute", [name]) if {
	some resource in resources
	resource.kind == "RemoteMCPServer"
	name := resource.metadata.name
	not has_resource("HTTPRoute", sprintf("mcp-%s", [name]))
}

deny contains sprintf("%s must authenticate every upstream transport", [backend.metadata.name]) if {
	some backend in resources
	backend.kind == "AgentgatewayBackend"
	object.get(backend.metadata.labels, "agentos.dev/environment", "") != ""
	object.get(backend.spec.policies, "extAuth", {}).failureMode != "FailClosed"
}

deny contains sprintf("%s trusts an unexpected environment TLS identity", [backend.metadata.name]) if {
	some backend in resources
	backend.kind == "AgentgatewayBackend"
	some environment in data.environments
	backend.metadata.labels["agentos.dev/environment"] == environment.name
	backend.spec.policies.tls.verifySubjectAltNames != [environment.gateway.host]
}

deny contains sprintf("%s exposes tools beyond its identity view", [backend.metadata.name]) if {
	some backend in resources
	backend.kind == "AgentgatewayBackend"
	engineer := backend.metadata.labels["agentos.dev/engineer"]
	some environment in data.environments
	environment.name == backend.metadata.labels["agentos.dev/environment"]
	project := trim_prefix(backend.spec.mcp.targets[0].name, sprintf("%s-", [environment.name]))
	some identity in environment.identities
	identity.name == engineer
	access := identity.services[project]
	tier := backend.metadata.labels["agentos.dev/tool-access"]
	expected := data.agentos.tools_for(environment.toolsets[project], access, tier)
	expression := backend.spec.policies.mcp.authorization.policy.matchExpressions[0]
	actual := json.unmarshal(trim_prefix(expression, "mcp.tool.name in "))
	sort(actual) != sort(expected)
}

deny contains sprintf("%s exposes an unregistered client", [backend.metadata.name]) if {
	some backend in resources
	backend.kind == "AgentgatewayBackend"
	backend.metadata.labels["agentos.dev/component"] == "environment-tool"
	project := backend.metadata.labels["agentos.dev/project"]
	not allowed_backend(backend.metadata.name, project)
}

allowed_backend(name, project) if {
	some identity in data.identities
	identity.services[project]
	name == sprintf("%s-%s", [project, identity.name])
}

deny contains sprintf("missing backend for %s/%s", [identity.name, project]) if {
	some identity in data.identities
	some project, _ in data.toolsets
	identity.services[project]
	not has_resource("AgentgatewayBackend", sprintf("%s-%s", [project, identity.name]))
}

deny contains sprintf("%s contains an unresolved credential placeholder", [backend.metadata.name]) if {
	some backend in resources
	backend.kind == "AgentgatewayBackend"
	walk(backend.spec.mcp.targets, [_, value])
	is_string(value)
	regex.match("<(identity|environment|issuer)>", value)
}

deny contains sprintf("%s advertises an origin outside its service audience", [remote.metadata.name]) if {
	some remote in resources
	remote.kind == "RemoteMCPServer"
	some backend in resources
	backend.kind == "AgentgatewayBackend"
	backend.metadata.name == remote.metadata.name
	source := backend.spec.mcp.targets[0].name
	some policy in resources
	policy.kind == "AgentgatewayPolicy"
	policy.metadata.name == sprintf("%s-runtime-auth", [source])
	origin := regex.find_n("^https?://[^/]+", remote.spec.url, 1)[0]
	not origin in policy.spec.traffic.jwtAuthentication.providers[0].audiences
}

deny contains sprintf("%s has no service for its scoped MCP origin", [remote.metadata.name]) if {
	some remote in resources
	remote.kind == "RemoteMCPServer"
	some backend in resources
	backend.kind == "AgentgatewayBackend"
	backend.metadata.name == remote.metadata.name
	source := backend.spec.mcp.targets[0].name
	not has_resource("Service", sprintf("%s-mcp-gateway", [source]))
}
