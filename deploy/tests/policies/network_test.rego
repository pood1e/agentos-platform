package runtime_tests

import rego.v1

controller_selector := {"matchLabels": {
	"app.kubernetes.io/name": "kagent",
	"app.kubernetes.io/instance": "kagent",
	"app.kubernetes.io/component": "controller",
}}

network_fixture := {"spec": {
	"podSelector": controller_selector,
	"policyTypes": ["Ingress"],
	"ingress": [{
		"from": [peer | some peer in controller_peers(controller_selector)],
		"ports": [{"port": "http", "protocol": "TCP"}],
	}],
}}

test_controller_ingress_accepts_trusted_backends if {
	restricted_controller(network_fixture, controller_selector)
}

test_controller_ingress_rejects_missing_policy if {
	messages := deny with controller_policy as null
	"native controller ingress must be restricted to trusted backends and Substrate egress" in messages
}

test_controller_ingress_rejects_open_ingress if {
	policy := json.patch(network_fixture, [{"op": "replace", "path": "/spec/ingress", "value": [{}]}])
	not restricted_controller(policy, controller_selector)
}

test_controller_ingress_rejects_unrelated_pods if {
	policy := json.patch(network_fixture, [{"op": "add", "path": "/spec/ingress/0/from/-", "value": {"podSelector": {"matchLabels": {"app.kubernetes.io/component": "voice"}}}}])
	not restricted_controller(policy, controller_selector)
}

test_controller_ingress_rejects_cross_namespace_trust if {
	rule := network_fixture.spec.ingress[0]
	peers := [object.union(peer, {"namespaceSelector": {}}) | some peer in rule.from]
	policy := json.patch(network_fixture, [{"op": "replace", "path": "/spec/ingress/0/from", "value": peers}])
	not restricted_controller(policy, controller_selector)
}

test_controller_ingress_rejects_unbounded_ports if {
	policy := json.patch(network_fixture, [{"op": "remove", "path": "/spec/ingress/0/ports"}])
	not restricted_controller(policy, controller_selector)
}

test_controller_ingress_rejects_wrong_target if {
	policy := json.patch(network_fixture, [{"op": "replace", "path": "/spec/podSelector", "value": {}}])
	not restricted_controller(policy, controller_selector)
}
