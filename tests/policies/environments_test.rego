package environment_tests

import rego.v1

test_readonly_identity_cannot_publish_a_write_view if {
	backend := {"kind": "AgentgatewayBackend", "metadata": {"name": "lab-kubernetes-inspection-changes", "labels": {"agentos.dev/environment": "lab", "agentos.dev/engineer": "inspection", "agentos.dev/tool-access": "write"}}, "spec": {"mcp": {"targets": [{"name": "lab-kubernetes"}]}, "policies": {"mcp": {"authorization": {"policy": {"matchExpressions": ["mcp.tool.name in [\"resources_apply\"]"]}}}}}}
	environment := {"name": "lab", "identities": [{"name": "inspection", "services": {"kubernetes": "read"}}], "toolsets": {"kubernetes": {"readOnly": ["pods_list"], "write": ["resources_apply"]}}}
	messages := deny with input as [{"contents": backend}] with data.environments as [environment]
	"lab-kubernetes-inspection-changes exposes tools beyond its identity view" in messages
}

test_credential_placeholders_must_be_resolved if {
	backend := {"kind": "AgentgatewayBackend", "metadata": {"name": "kubernetes-inspection"}, "spec": {"mcp": {"targets": [{"static": {"policies": {"auth": {"secretRef": {"name": "backend-<identity>"}}}}}]}}}
	messages := deny with input as [{"contents": backend}]
	"kubernetes-inspection contains an unresolved credential placeholder" in messages
}
