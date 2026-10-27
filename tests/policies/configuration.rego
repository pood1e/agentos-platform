package main

import rego.v1

deny contains "Actor keys require a private HTTP/1.1 listener" if {
	some service in objects
	service.kind == "Service"
	service.metadata.name == console.metadata.name
	ports := [port | some port in service.spec.ports; port.name == "jwks"; port.port == 9092; object.get(port, "appProtocol", "") != "kubernetes.io/h2c"]
	count(ports) != 1
}

deny contains "Actor keys exclude the agentgateway controller" if {
	some policy in objects
	policy.kind == "NetworkPolicy"
	policy.metadata.name == console.metadata.name
	not jwks_controller_peer(policy)
}

jwks_controller_peer(policy) if {
	some ingress in policy.spec.ingress
	some port in ingress.ports
	port.port == 9092
	some peer in ingress.from
	peer.namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "agentgateway-system"
	peer.podSelector.matchLabels.agentgateway == "agentgateway"
}

console_role := resource if {
	some resource in objects
	resource.kind == "Role"
	resource.metadata.name == console.metadata.name
}

configuration_permission(group, resource, verb) if {
	some rule in console_role.rules
	group in rule.apiGroups
	resource in rule.resources
	verb in rule.verbs
}

deny contains sprintf("console cannot watch configuration %s/%s", [group, resource]) if {
	some group, resources in {
		"api.kagent.dev": ["agents", "agenttemplates", "modelconfigs", "harnesses"],
		"agentgateway.dev": ["agentgatewaybackends"],
        "agentos.dev": ["accessplans"],
	}
	some resource in resources
	not configuration_permission(group, resource, "watch")
}

deny contains sprintf("console can mutate derived resource %s/%s", [group, resource]) if {
 some group, resources in {"api.kagent.dev": ["modelconfigs", "remotemcpservers"], "gateway.networking.k8s.io": ["httproutes"], "agentgateway.dev": ["agentgatewaypolicies"]}
 some resource in resources
 some verb in ["create", "update", "delete"]
 configuration_permission(group, resource, verb)
}
