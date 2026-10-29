package main

import rego.v1

app_plan := {"kind": "AccessPlan", "metadata": {"name": "platform"}, "spec": {"platform": {"appAuthorityBackend": "app-authority", "appJWTProvider": {"issuer": "https://identity.test"}}}}
app_backend := {"kind": "AgentgatewayBackend", "metadata": {"name": "app-authority"}, "spec": {"static": {"host": "agentos-api", "port": 8080}}}
app_ingress := {"from": [gateway_peer], "ports": [{"port": 8080, "protocol": "TCP"}]}

app_authority_objects(ingress, backend) := [
	{"contents": fixture_workload("api")},
	{"contents": object.union(fixture_ingress("api", []), {"spec": {"podSelector": {"matchLabels": fixture_labels("api")}, "ingress": [ingress]}})},
	{"contents": app_plan},
	{"contents": backend},
]

test_app_authority_admits_only_declared_api_gateway if {
	messages := deny with input as app_authority_objects(app_ingress, app_backend)
	not "only the dataplane admits gateways and Agent runtimes" in messages
}

test_app_authority_rejects_other_ports if {
	ingress := object.union(app_ingress, {"ports": [{"port": 9092, "protocol": "TCP"}]})
	messages := deny with input as app_authority_objects(ingress, app_backend)
	"only the dataplane admits gateways and Agent runtimes" in messages
}

test_app_authority_rejects_cross_namespace_gateways if {
	peer := object.union(gateway_peer, {"namespaceSelector": {}})
	ingress := object.union(app_ingress, {"from": [peer]})
	messages := deny with input as app_authority_objects(ingress, app_backend)
	"only the dataplane admits gateways and Agent runtimes" in messages
}

test_app_authority_rejects_agent_runtime if {
	ingress := object.union(app_ingress, {"from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ate-system"}}}]})
	messages := deny with input as app_authority_objects(ingress, app_backend)
	"only the dataplane admits gateways and Agent runtimes" in messages
}

test_app_authority_rejects_an_unrelated_backend if {
	backend := object.union(app_backend, {"spec": {"static": {"host": "other-api", "port": 8080}}})
	messages := deny with input as app_authority_objects(app_ingress, backend)
	"only the dataplane admits gateways and Agent runtimes" in messages
}
