package runtime_tests

import rego.v1

deny contains "native controller must verify OIDC identity" if not native_authentication

native_authentication if {
	native_config.server.auth == kagent.config.server.auth
	native_config.server.auth.mode == "oidc"
	startswith(native_config.server.auth.oidc.issuer, "https://")
	native_config.server.auth.oidc.audience != ""
}

deny contains "native execution authority differs from site policy" if not native_authority

native_authority if {
	authority := native_config.executionAuthorization
	authority == kagent.config.executionAuthorization
	authority.scopeClaim != ""
	is_array(authority.gatewayAudiences)
	count(authority.gatewayAudiences) > 0
	count(authority.rules) > 0
	authority.encryptionKeyFile == "/etc/kagent/execution/key"
	startswith(authority.oauth.tokenEndpoint, "https://")
	authority.oauth.clientId != ""
	authority.oauth.clientSecretFile == "/etc/kagent/identity/client-secret"
	authority.oauth.assertionIssuer == "http://kagent-controller.agentos.svc.cluster.local:8083/delegation"
	authority.oauth.assertionKeyFile == "/etc/kagent/delegation/key.pem"
}

deny contains "native delegation assertion key must be controller-only" if not native_assertion_key_volume

native_assertion_key_volume if {
	volume := native_controller.spec.template.spec.volumes[_]
	volume.name == "delegation-assertion"
	volume.secret == {"secretName": "kagent-delegation-assertion", "defaultMode": 288}
	container := native_controller.spec.template.spec.containers[_]
	container.name == "controller"
	container.volumeMounts[_] == {"name": "delegation-assertion", "mountPath": "/etc/kagent/delegation", "readOnly": true}
}

deny contains "native execution key must be controller-only" if not native_execution_key_volume

native_execution_key_volume if {
	volume := native_controller.spec.template.spec.volumes[_]
	volume.name == "execution-credentials"
	volume.secret == {"secretName": "kagent-execution-credentials", "defaultMode": 288}
	container := native_controller.spec.template.spec.containers[_]
	container.name == "controller"
	container.volumeMounts[_] == {"name": "execution-credentials", "mountPath": "/etc/kagent/execution", "readOnly": true}
	native_controller.spec.template.spec.securityContext.fsGroup == 65532
}

deny contains "native identity renewal requires a mounted client Secret" if not native_identity_volume

native_identity_volume if {
	volume := native_controller.spec.template.spec.volumes[_]
	volume.name == "identity-client"
	volume.secret.defaultMode == 288
	volume.secret.items == [{"key": "client-secret", "path": "client-secret"}]
	container := native_controller.spec.template.spec.containers[_]
	container.name == "controller"
	container.volumeMounts[_] == {"name": "identity-client", "mountPath": "/etc/kagent/identity", "readOnly": true}
}

deny contains "native API must verify invocation service accounts" if not native_invocation_authentication

native_invocation_authentication if {
 native_config.server.auth.serviceAccount.authority == "kubernetes"
}

deny contains "native MCP discovery cannot mint ServiceAccount tokens" if not native_discovery_tokens

native_discovery_tokens if {
	some file in input
	file.contents.kind in {"Role", "ClusterRole"}
	some rule in file.contents.rules
	"serviceaccounts/token" in rule.resources
	"create" in rule.verbs
}

deny contains "native OIDC and OAuth renewal must share private IdP trust" if {
	native_config.server.auth.oidc.caFile
	not native_identity_trust
}

native_identity_trust if {
	native_config.server.auth.oidc.caFile == "/etc/kagent/identity-ca/ca.crt"
	native_config.executionAuthorization.oauth.caFile == "/etc/kagent/identity-ca/ca.crt"
	volume := native_controller.spec.template.spec.volumes[_]
	volume.name == "identity-ca"
	volume.configMap == {"name": "identity-ca", "items": [{"key": "issuer.pem", "path": "ca.crt"}]}
	container := native_controller.spec.template.spec.containers[_]
	container.name == "controller"
	container.volumeMounts[_] == {"name": "identity-ca", "mountPath": "/etc/kagent/identity-ca", "readOnly": true}
}
