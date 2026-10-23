package main

import rego.v1

objects := [entry.contents | some entry in input; is_object(entry.contents); entry.contents.kind]

console := resource if {
	some resource in objects
	resource.kind == "Deployment"
	endswith(resource.metadata.name, "-console")
}

environment := {entry.name: entry | some entry in console.spec.template.spec.containers[0].env}
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
	not endswith(hostname(remote.spec.url), ".svc.cluster.local")
}

deny contains sprintf("%s bypasses the shared MCP gateway", [remote.metadata.name]) if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	not contains(remote.spec.url, "agentos-mcp-gateway.")
}

deny contains sprintf("%s does not use bound Kubernetes discovery", [remote.metadata.name]) if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	object.get(object.get(remote.metadata, "annotations", {}), "agentos.dev/discovery-auth", "") != "kubernetes"
}

deny contains sprintf("%s exposes static discovery headers", [remote.metadata.name]) if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	object.get(remote.spec, "headersFrom", []) != []
}

deny contains sprintf("%s has a different discovery timeout", [remote.metadata.name]) if {
	some remote in objects
	remote.kind == "RemoteMCPServer"
	remote.spec.timeout != "10m"
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

deny contains "native MCP session owner differs from the controller user" if {
	some policy in objects
	policy.metadata.name == "kagent-collaboration-tool-access"
	some header in policy.spec.traffic.transformation.request.set
	header.name == "x-user-id"
	json.unmarshal(header.value) != environment.KAGENT_USER_ID.value
}

deny contains "missing native collaboration owner policy" if not resource_exists("AgentgatewayPolicy", "kagent-collaboration-tool-access")

deny contains sprintf("obsolete runtime credential %s", [name]) if {
	some name in {"AGENTOS_GATEWAY_TOKEN", "AGENTOS_MCP_TOKEN", "AGENTOS_AUTH_CONFIG", "AGENTOS_SPEECH_CONFIG"}
	environment[name]
}

deny contains "workload model token is not read from the projected volume" if environment.AGENTOS_MODEL_TOKEN_FILE.value != "/var/run/agentos-model/token"

deny contains "runtime origins must remain inside the cluster" if {
	urls := array.concat([environment.AGENTOS_GATEWAY_URL.value, environment.AGENTOS_MCP_GATEWAY_URL.value], json.unmarshal(environment.AGENTOS_ACTOR_AUDIENCES.value))
	some url in urls
	not endswith(hostname(url), ".svc.cluster.local")
}

deny contains "browser OIDC credentials are exposed in the anonymous mode" if {
	environment.AGENTOS_AUTH_MODE.value == "none"
	environment.AGENTOS_OIDC_ISSUER
}

deny contains "the console ingress does not target the direct HTTP service" if {
	some ingress in objects
	ingress.kind == "Ingress"
	endswith(ingress.metadata.name, "-console")
	ingress.spec.rules[0].http.paths[0].backend.service.port.name != "http"
}

deny contains sprintf("obsolete platform resource %s/%s", [resource.kind, resource.metadata.name]) if {
	some resource in objects
	resource.kind in {"Namespace", "Middleware"}
}

deny contains sprintf("obsolete platform component %s", [resource.metadata.name]) if {
	some resource in objects
	contains(resource.metadata.name, "oauth2-proxy")
}

deny contains "collaboration must share the platform API process" if {
	some resource in objects
	resource.kind == "Deployment"
	endswith(resource.metadata.name, "-team-sessions")
}

deny contains "team-sessions does not target the platform API" if {
	some backend in objects
	backend.kind == "AgentgatewayBackend"
	backend.metadata.name == "team-sessions"
	backend.spec.mcp.targets[0].static.host != console.metadata.name
}

deny contains "team-sessions uses a different HTTP port" if {
	some backend in objects
	backend.kind == "AgentgatewayBackend"
	backend.metadata.name == "team-sessions"
	backend.spec.mcp.targets[0].static.port != 8080
}

deny contains "OIDC requires native client and cookie secret references" if {
	environment.AGENTOS_AUTH_MODE.value == "oidc"
	some name, key in {"AGENTOS_OIDC_CLIENT_SECRET": "client-secret", "AGENTOS_COOKIE_SECRET": "cookie-secret"}
	object.get(object.get(object.get(object.get(environment, name, {}), "valueFrom", {}), "secretKeyRef", {}), "key", "") != key
}

deny contains "speech configuration must remain in the managed Secret" if {
	environment.AGENTOS_SPEECH_SECRET.value != sprintf("%s-speech", [trim_suffix(console.metadata.name, "-console")])
}

deny contains "speech credentials are projected into the console" if {
	some volume in console.spec.template.spec.volumes
	startswith(volume.name, "speech")
}

deny contains "speech credentials are mounted in the console" if {
	some mount in console.spec.template.spec.containers[0].volumeMounts
	startswith(mount.name, "speech")
}

deny contains sprintf("required platform environment %s is absent", [name]) if {
	some name in {"KAGENT_USER_ID", "AGENTOS_AUTH_MODE", "AGENTOS_GATEWAY_URL", "AGENTOS_MCP_GATEWAY_URL", "AGENTOS_ACTOR_AUDIENCES", "AGENTOS_WORKLOAD_AUTH_CONFIG", "AGENTOS_MODEL_TOKEN_FILE", "AGENTOS_SPEECH_SECRET"}
	not environment[name]
}

deny contains "the console ingress has an obsolete auth middleware" if {
	some ingress in objects
	ingress.kind == "Ingress"
	endswith(ingress.metadata.name, "-console")
	ingress.metadata.annotations["traefik.ingress.kubernetes.io/router.middlewares"]
}

deny contains "gateway NetworkPolicy excludes the console" if {
	some policy in objects
	policy.kind == "NetworkPolicy"
	endswith(policy.metadata.name, "-gateway")
	not console_peer(policy)
}

console_peer(policy) if {
	some ingress in policy.spec.ingress
	some peer in ingress.from
	peer.podSelector.matchLabels["app.kubernetes.io/component"] == "console"
}

deny contains "native session owner headers must be unique" if {
	some policy in objects
	policy.metadata.name == "kagent-collaboration-tool-access"
	headers := object.get(object.get(object.get(policy.spec.traffic, "transformation", {}), "request", {}), "set", [])
	count([header | some header in headers; header.name == "x-user-id"]) != 1
}

deny contains "an unrelated policy injects native session ownership" if {
	some policy in objects
	policy.kind == "AgentgatewayPolicy"
	policy.metadata.name != "kagent-collaboration-tool-access"
	some header in policy.spec.traffic.transformation.request.set
	header.name == "x-user-id"
}
