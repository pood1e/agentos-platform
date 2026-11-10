package runtime_tests

import rego.v1

public_resource(kind) := file.contents if {
	some file in input
	file.contents.kind == kind
	file.contents.metadata.name == "kagent-public"
}

deny contains "native execution ingress must support HTTP/2" if public_resource("Service").spec.ports != [{"name": "http", "port": 8083, "targetPort": "http", "appProtocol": "kubernetes.io/h2c"}]

deny contains "native execution ingress must target the controller" if public_resource("Service").spec.selector != native_controller.spec.selector.matchLabels

deny contains "native public endpoints differ from the execution contract" if {match.path.value | some match in public_resource("HTTPRoute").spec.rules[0].matches} != {"/agents/", "/lf.a2a.v1.A2AService/", "/kagent.api.v1.ExecutionService/", "/kagent.api.v1.SessionService/"}

deny contains "native execution ingress must use the public API host" if public_resource("HTTPRoute").spec.hostnames != ["api.example.test"]

deny contains "native public ingress must trust only the site gateway" if public_resource("NetworkPolicy").spec.ingress != [{"from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}, "podSelector": {"matchLabels": {"app.kubernetes.io/name": "traefik"}}}], "ports": [{"port": "http", "protocol": "TCP"}]}]

deny contains "native execution ingress is incomplete" if {
	some kind in ["Service", "HTTPRoute", "NetworkPolicy"]
	not public_resource(kind)
}
