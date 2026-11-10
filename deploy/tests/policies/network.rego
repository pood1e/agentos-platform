package runtime_tests

import rego.v1

native_controller := file.contents if {
	some file in input
	file.contents.kind == "Deployment"
	file.contents.metadata.name == "kagent-controller"
}

controller_policy := file.contents if {
	some file in input
	file.contents.kind == "NetworkPolicy"
	file.contents.metadata.name == "kagent-controller"
}

controller_peers(selector) := {
	{"podSelector": selector},
	{"podSelector": {"matchLabels": {"agentos.dev/gateway": "business"}}},
	{"podSelector": {
		"matchLabels": {"app.kubernetes.io/name": "agentos"},
		"matchExpressions": [{"key": "app.kubernetes.io/component", "operator": "In", "values": ["api", "dataplane"]}],
	}},
	{
		"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "ate-system"}},
		"podSelector": {"matchLabels": {"app": "atenet-egress"}},
	},
}

restricted_controller(policy, selector) if {
	policy.spec.podSelector == selector
	policy.spec.policyTypes == ["Ingress"]
	count(policy.spec.ingress) == 1
	rule := policy.spec.ingress[0]
	rule.ports == [{"port": "http", "protocol": "TCP"}]
	{peer | some peer in rule.from} == controller_peers(selector)
}

deny contains "native controller ingress must be restricted to trusted backends and Substrate egress" if not controller_policy.spec

deny contains "native controller ingress must be restricted to trusted backends and Substrate egress" if {
	controller_policy
	not restricted_controller(controller_policy, native_controller.spec.selector)
}

deny contains "native controller API must expose its named http port" if {
	native_controller
	not some_http_port
}

some_http_port if {
	some container in native_controller.spec.template.spec.containers
	some port in container.ports
	port.name == "http"
	port.protocol == "TCP"
}
