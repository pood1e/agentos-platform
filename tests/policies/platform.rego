package main

import rego.v1

objects := [entry.contents | some entry in input; is_object(entry.contents); entry.contents.kind]

platform(component) := resource if {
	some resource in objects
	resource.kind == "Deployment"
	resource.spec.template.metadata.labels["app.kubernetes.io/name"] == "agentos"
	resource.spec.template.metadata.labels["app.kubernetes.io/component"] == component
}

api := platform("api")

dataplane := platform("dataplane")

workloads := [api, dataplane]

environment_of(deployment) := {entry.name: entry | some entry in deployment.spec.template.spec.containers[0].env}

api_environment := environment_of(api)

dataplane_environment := environment_of(dataplane)
hostname(url) := split(split(split(url, "://")[1], "/")[0], ":")[0]

resource_exists(kind, name) if {
	some resource in objects
	resource.kind == kind
	resource.metadata.name == name
}

deny contains "duplicate resource identities" if {
	keys := [sprintf("%s/%s/%s/%s", [r.apiVersion, r.kind, object.get(r.metadata, "namespace", ""), r.metadata.name]) | some r in objects]
	count(keys) != count({key | some key in keys})
}

deny contains sprintf("%s has an unsupported traffic policy target", [policy.metadata.name]) if {
	some policy in objects
	policy.kind == "AgentgatewayPolicy"
	policy.spec.traffic
	targets := array.concat(object.get(policy.spec, "targetRefs", []), object.get(policy.spec, "targetSelectors", []))
	some target in targets
	not target.kind in {"Gateway", "HTTPRoute", "GRPCRoute", "ListenerSet", "InferencePool"}
}

deny contains sprintf("%s exposes a non-internal MCP address", [remote.metadata.name]) if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	remote.metadata.name != "kagent-collaboration"
	not endswith(hostname(remote.spec.url), ".svc.cluster.local")
}

deny contains sprintf("%s exposes static discovery headers", [remote.metadata.name]) if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	object.get(remote.spec, "headersFrom", []) != []
}

deny contains sprintf("%s has a different discovery timeout", [remote.metadata.name]) if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	time.parse_duration_ns(remote.spec.timeout) != 600000000000
}

deny contains "model and MCP credentials share a host" if {
	some model in objects
	model.kind == "ModelConfig"
	some remote in objects
	remote.kind == "RemoteMCPServer"
	hostname(model.spec.openAI.baseUrl) == hostname(remote.spec.url)
}

deny contains sprintf("%s has a static platform API-key policy", [policy.metadata.name]) if {
	some policy in objects
	policy.kind == "AgentgatewayPolicy"
	policy.spec.traffic.apiKeyAuthentication
}

deny contains sprintf("%s lacks its ten-minute MCP transport budget", [backend.metadata.name]) if {
	some backend in objects
	backend.kind == "AgentgatewayBackend"
	some target in backend.spec.mcp.targets
	object.get(object.get(target.static.policies, "http", {}), "requestTimeout", "") != "10m"
}

deny contains "the API route does not target the platform HTTP service" if {
	some route in objects
	route.kind == "HTTPRoute"
	endswith(route.metadata.name, "-api")
	route.spec.rules[0].backendRefs[0] != {"name": api.metadata.name, "port": 8080}
}

deny contains sprintf("the platform chart renders site resource %s/%s", [resource.kind, resource.metadata.name]) if {
	some resource in objects
	resource.kind in {"Namespace", "Middleware", "Ingress"}
}

deny contains "collaboration must run in the dataplane" if {
	some resource in objects
	resource.kind == "Deployment"
	endswith(resource.metadata.name, "-team-sessions")
}

deny contains "team-sessions does not target the dataplane" if {
	some backend in objects
	backend.kind == "AgentgatewayBackend"
	backend.metadata.name == "team-sessions"
	backend.spec.mcp.targets[0].static.host != dataplane.metadata.name
}

deny contains "team-sessions uses a different HTTP port" if {
	some backend in objects
	backend.kind == "AgentgatewayBackend"
	backend.metadata.name == "team-sessions"
	backend.spec.mcp.targets[0].static.port != 8080
}

deny contains "OIDC requires native client and delegation secret references" if {
	some name, key in {"AGENTOS_OIDC_CLIENT_SECRET": "client-secret", "AGENTOS_COOKIE_SECRET": "delegation"}
	object.get(object.get(object.get(object.get(api_environment, name, {}), "valueFrom", {}), "secretKeyRef", {}), "key", "") != key
}

deny contains "speech configuration must remain in the managed Secret" if {
	api_environment.AGENTOS_SPEECH_SECRET.value != sprintf("%s-speech", [trim_suffix(api.metadata.name, "-api")])
}

deny contains "speech credentials are projected into a platform process" if {
	some workload in workloads
	some volume in workload.spec.template.spec.volumes
	startswith(volume.name, "speech")
}

deny contains sprintf("required %s environment %s is absent", [component, name]) if {
	some component, names in {
		"api": {"AGENTOS_OIDC_ISSUER", "AGENTOS_API_ORIGIN", "AGENTOS_GATEWAY_URL", "AGENTOS_MCP_GATEWAY_URL", "AGENTOS_SPEECH_SECRET"},
		"dataplane": {"KAGENT_URL", "AGENTOS_CONTROLLER_SUBJECT"},
	}
	some name in names
	not environment_of(platform(component))[name]
}

deny contains "the dataplane lacks a second replica or its disruption budget" if {
	dataplane.spec.replicas < 2
}

deny contains "the dataplane lacks a second replica or its disruption budget" if {
	not disruption_budget(dataplane)
}

disruption_budget(deployment) if {
	some budget in objects
	budget.kind == "PodDisruptionBudget"
	budget.spec.selector.matchLabels == deployment.spec.selector.matchLabels
	budget.spec.maxUnavailable == 1
}

deny contains "native collaboration endpoint differs from the native control plane" if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	remote.metadata.name == "kagent-collaboration"
	remote.spec.url != concat("", [api_environment.KAGENT_URL.value, "/mcp"])
}

deny contains sprintf("%s lacks native discovery credentials", [remote.metadata.name]) if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	remote.metadata.name in {"team-sessions", "kagent-collaboration"}
	not remote.spec.discoveryAuth.serviceAccount.audience
}

deny contains "platform process owns execution persistence or authority" if {
	some workload in workloads
	some entry in workload.spec.template.spec.containers[0].env
	startswith(entry.name, "AGENTOS_EXECUTION_")
}

deny contains "business dataplane exposes a runtime proxy port" if {
	some port in dataplane.spec.template.spec.containers[0].ports
	port.containerPort != 8080
}
