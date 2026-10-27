package environment_tests

import rego.v1

test_readonly_identity_cannot_publish_a_write_view if {
	backend := {"kind": "AgentgatewayBackend", "metadata": {"name": "lab-kubernetes-inspection-changes", "labels": {"agentos.dev/environment": "lab", "agentos.dev/engineer": "inspection", "agentos.dev/tool-access": "write"}}, "spec": {"mcp": {"targets": [{"name": "lab-kubernetes"}]}, "policies": {"mcp": {"authorization": {"policy": {"matchExpressions": ["mcp.tool.name in [\"resources_apply\"]"]}}}}}}
	environment := {"name": "lab", "identities": [{"name": "inspection", "services": {"kubernetes": "read"}}], "toolsets": {"kubernetes": {"readOnly": ["pods_list"], "write": ["resources_apply"]}}}
	plan := {"contents": {"kind": "AccessPlan", "metadata": {"name": "test"}, "status": {"targets": [{"server": backend.metadata.name, "engineer": "inspection", "tools": []}]}}}
 messages := deny with input as [{"contents": backend}, plan] with data.environments as [environment]
	"lab-kubernetes-inspection-changes exposes tools beyond its identity view" in messages
}

test_credential_placeholders_must_be_resolved if {
	backend := {"kind": "AgentgatewayBackend", "metadata": {"name": "kubernetes-inspection"}, "spec": {"mcp": {"targets": [{"static": {"policies": {"auth": {"secretRef": {"name": "backend-<identity>"}}}}}]}}}
	messages := deny with input as [{"contents": backend}]
	"kubernetes-inspection contains an unresolved credential placeholder" in messages
}

mcp_origin_resources(origin) := [
	{"contents": {"kind": "RemoteMCPServer", "metadata": {"name": "lab-kubernetes-inspection"}, "spec": {"url": sprintf("%s/mcp/lab-kubernetes/inspection/readonly", [origin])}}},
	{"contents": {"kind": "AgentgatewayBackend", "metadata": {"name": "lab-kubernetes-inspection", "labels": {"agentos.dev/environment": "lab"}}, "spec": {"mcp": {"targets": [{"name": "lab-kubernetes"}]}, "policies": {"extAuth": {"failureMode": "FailClosed"}}}}},
	{"contents": {"kind": "AgentgatewayPolicy", "metadata": {"name": "lab-kubernetes-runtime-auth"}, "spec": {"traffic": {"jwtAuthentication": {"providers": [{"audiences": ["http://lab-kubernetes-mcp-gateway.agentos.svc.cluster.local:8080"]}]}}}}},
	{"contents": {"kind": "HTTPRoute", "metadata": {"name": "mcp-lab-kubernetes-inspection"}}},
	{"contents": {"kind": "Service", "metadata": {"name": "lab-kubernetes-mcp-gateway"}}},
]

test_advertised_origin_must_match_service_audience if {
	resources := mcp_origin_resources("http://agentos-mcp-gateway.agentos.svc.cluster.local:8080")
	messages := deny with input as resources
	"lab-kubernetes-inspection advertises an origin outside its service audience" in messages
}

test_service_scoped_origin_is_accepted if {
	resources := mcp_origin_resources("http://lab-kubernetes-mcp-gateway.agentos.svc.cluster.local:8080")
	messages := deny with input as resources
	count(messages) == 0
}

test_service_scoped_origin_requires_a_service if {
	resources := [item | some item in mcp_origin_resources("http://lab-kubernetes-mcp-gateway.agentos.svc.cluster.local:8080"); item.contents.kind != "Service"]
	messages := deny with input as resources
	"lab-kubernetes-inspection has no service for its scoped MCP origin" in messages
}
