package main

import rego.v1

deny contains "Actor keys require a private HTTP/1.1 listener" if {
	some service in objects
	service.kind == "Service"
	service.metadata.name == dataplane.metadata.name
	ports := [port | some port in service.spec.ports; port.name == "jwks"; port.port == 9092; object.get(port, "appProtocol", "") != "kubernetes.io/h2c"]
	count(ports) != 1
}

deny contains "Actor keys exclude the agentgateway controller" if {
	not jwks_controller_peer(ingress_policy(dataplane))
}

jwks_controller_peer(policy) if {
	some ingress in policy.spec.ingress
	some port in ingress.ports
	port.port == 9092
	some peer in ingress.from
	peer.namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "agentgateway-system"
	peer.podSelector.matchLabels.agentgateway == "agentgateway"
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

deny contains sprintf("%s cannot watch authorization plans", [worker.metadata.name]) if {
	not configuration_permission(worker, "agentos.dev", "accessplans", "watch")
}

deny contains sprintf("%s can mutate derived resource %s/%s", [workload.metadata.name, group, resource]) if {
	some workload in workloads
	some group, resources in {"api.kagent.dev": ["modelconfigs", "remotemcpservers"], "gateway.networking.k8s.io": ["httproutes"], "agentgateway.dev": ["agentgatewaypolicies"]}
	some resource in resources
	some verb in ["create", "update", "delete"]
	configuration_permission(workload, group, resource, verb)
}

deny contains sprintf("%s can write Kubernetes resources", [workload.metadata.name]) if {
	some workload in [dataplane, worker]
	some rule in role_of(workload).rules
	some verb in rule.verbs
	not verb in {"get", "list", "watch"}
}
