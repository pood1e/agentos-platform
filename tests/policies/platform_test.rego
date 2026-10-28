package main

import rego.v1

test_static_discovery_headers_are_rejected if {
	remote := {"kind": "RemoteMCPServer", "metadata": {"name": "tools"}, "spec": {"url": "http://agentos-mcp-gateway.agentos.svc.cluster.local:8080/mcp", "timeout": "10m", "headersFrom": [{"secretRef": "legacy"}]}}
	messages := deny with input as [{"contents": remote}]
	"tools exposes static discovery headers" in messages
}

test_missing_discovery_identity_is_rejected if {
	remote := {"kind": "RemoteMCPServer", "metadata": {"name": "tools"}, "spec": {"url": "http://agentos-mcp-gateway.agentos.svc.cluster.local:8080/mcp", "timeout": "10m"}}
	messages := deny with input as [{"contents": remote}]
	"tools does not use bound Kubernetes discovery" in messages
}

test_model_and_mcp_credentials_cannot_share_an_authority if {
	remote := {"kind": "RemoteMCPServer", "metadata": {"name": "tools"}, "spec": {"url": "http://same.agentos.svc.cluster.local:8080/mcp"}}
	model := {"kind": "ModelConfig", "metadata": {"name": "model"}, "spec": {"openAI": {"baseUrl": "http://same.agentos.svc.cluster.local:8080/v1"}}}
	messages := deny with input as [{"contents": remote}, {"contents": model}]
	"model and MCP credentials share a host" in messages
}

test_duplicate_resource_ownership_is_rejected if {
	service := {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "shared"}}
	messages := deny with input as [{"contents": service}, {"contents": service}]
	"duplicate resource identities" in messages
}

fixture_labels(component) := {"app.kubernetes.io/name": "agentos", "app.kubernetes.io/instance": "agentos", "app.kubernetes.io/component": component}

fixture_workload(component) := {"kind": "Deployment", "metadata": {"name": sprintf("agentos-%s", [component])}, "spec": {"replicas": 2, "selector": {"matchLabels": fixture_labels(component)}, "template": {"metadata": {"labels": fixture_labels(component)}, "spec": {"containers": [{"env": []}], "volumes": []}}}}

fixture_ingress(component, peers) := {"kind": "NetworkPolicy", "metadata": {"name": sprintf("agentos-%s", [component])}, "spec": {"podSelector": {"matchLabels": fixture_labels(component)}, "policyTypes": ["Ingress"], "ingress": [{"from": peers}]}}

gateway_peer := {"podSelector": {"matchLabels": {"agentos.dev/gateway": "business"}}}

test_worker_inbound_connections_are_rejected if {
	messages := deny with input as [{"contents": fixture_workload("worker")}, {"contents": fixture_ingress("worker", [gateway_peer])}]
	"the worker accepts inbound connections" in messages
}

test_gateways_reaching_the_api_are_rejected if {
	messages := deny with input as [{"contents": fixture_workload("api")}, {"contents": fixture_ingress("api", [gateway_peer])}]
	"only the dataplane admits gateways and Agent runtimes" in messages
}

test_console_traffic_to_the_dataplane_is_rejected if {
	web := {"podSelector": {"matchLabels": {"app.kubernetes.io/component": "web"}}}
	messages := deny with input as [{"contents": fixture_workload("dataplane")}, {"contents": fixture_ingress("dataplane", [web])}]
	"the dataplane admits console or external clients" in messages
}

test_a_single_dataplane_replica_is_rejected if {
	single := object.union(fixture_workload("dataplane"), {"spec": {"replicas": 1}})
	messages := deny with input as [{"contents": single}]
	"the dataplane lacks a second replica or its disruption budget" in messages
}
