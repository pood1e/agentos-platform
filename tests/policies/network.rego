package main

import rego.v1

ingress_policy(deployment) := policy if {
	some policy in objects
	policy.kind == "NetworkPolicy"
	policy.spec.podSelector.matchLabels == deployment.spec.selector.matchLabels
}

runtime_peer(peer) if peer.podSelector.matchLabels["agentos.dev/gateway"] == "business"

runtime_peer(peer) if peer.namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "ate-system"

deny contains sprintf("%s lacks an ingress policy", [workload.metadata.name]) if {
	some workload in workloads
	not ingress_policy(workload)
}

deny contains "the API admits gateways or Agent runtimes" if {
	some ingress in object.get(ingress_policy(api).spec, "ingress", [])
	some peer in ingress.from
	runtime_peer(peer)
	not app_authority_ingress(ingress, peer)
}

deny contains "gateway NetworkPolicy excludes the API" if {
	some policy in objects
	policy.kind == "NetworkPolicy"
	endswith(policy.metadata.name, "-gateway")
	not platform_peer(policy, "api")
}

platform_peer(policy, component) if {
	some ingress in policy.spec.ingress
	some peer in ingress.from
	peer.podSelector.matchLabels["app.kubernetes.io/name"] == "agentos"
	some expression in peer.podSelector.matchExpressions
	expression.key == "app.kubernetes.io/component"
	expression.operator == "In"
	component in expression.values
}

app_authority_ingress(ingress, peer) if {
	peer == {"podSelector": {"matchLabels": {"agentos.dev/gateway": "business"}}}
	ingress.ports == [{"port": 8080, "protocol": "TCP"}]
	some plan in objects
	plan.kind == "AccessPlan"
	plan.spec.platform.appJWTProvider.issuer != ""
	object.get(plan.metadata, "namespace", "") == object.get(api.metadata, "namespace", "")
	some backend in objects
	backend.kind == "AgentgatewayBackend"
	backend.metadata.name == plan.spec.platform.appAuthorityBackend
	object.get(backend.metadata, "namespace", "") == object.get(api.metadata, "namespace", "")
	backend.spec.static == {"host": api.metadata.name, "port": 8080}
}
