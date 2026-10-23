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
