package main

import rego.v1

ingress_policy(deployment) := policy if {
	some policy in objects
	policy.kind == "NetworkPolicy"
	policy.spec.podSelector.matchLabels == deployment.spec.selector.matchLabels
}

runtime_peer(peer) if peer.podSelector.matchLabels["agentos.dev/gateway"] == "business"

runtime_peer(peer) if peer.namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "ate-system"

ingress_peers(deployment) := [peer |
	some ingress in object.get(ingress_policy(deployment).spec, "ingress", [])
	some peer in ingress.from
]

deny contains sprintf("%s lacks an ingress policy", [workload.metadata.name]) if {
	some workload in workloads
	not ingress_policy(workload)
}

deny contains "only the dataplane admits gateways and Agent runtimes" if {
	some ingress in object.get(ingress_policy(api).spec, "ingress", [])
	some peer in ingress.from
	runtime_peer(peer)
	not app_authority_ingress(ingress, peer)
}

deny contains "the dataplane admits console or external clients" if {
	some peer in ingress_peers(dataplane)
	not runtime_peer(peer)
}

deny contains sprintf("gateway NetworkPolicy excludes the %s", [component]) if {
	some policy in objects
	policy.kind == "NetworkPolicy"
	endswith(policy.metadata.name, "-gateway")
	some component in ["api", "dataplane"]
	not platform_peer(policy, component)
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
