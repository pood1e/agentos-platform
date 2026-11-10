package runtime_tests

import rego.v1

kagent := file.contents if {
	some file in input
	endswith(file.path, "kagent-values.yaml")
}

substrate := file.contents if {
	some file in input
	endswith(file.path, "substrate-values.yaml")
}

atelet := file.contents if {
	some file in input
	endswith(file.path, "atelet-values.yaml")
}

native_config := yaml.unmarshal(file.contents.data["controller.yaml"]) if {
	some file in input
	file.contents.kind == "ConfigMap"
	file.contents.data["controller.yaml"]
}

deny contains "native controller configuration is missing" if not native_config

deny contains "OpenFGA authentication and CA paths are missing" if {
	kagent.config.authorization
	kagent.config.authorization.apiTokenFile != "/etc/kagent/authorization/token"
}

deny contains "OpenFGA CA path is missing" if {
	kagent.config.authorization
	kagent.config.authorization.caFile != "/etc/kagent/authorization-ca/ca.crt"
}

deny contains "OpenFGA API credential mount is missing" if {
	kagent.config.authorization
	names := {mount.name | some mount in kagent.controller.volumeMounts}
	not names["authorization-api"]
}

deny contains "OpenFGA CA mount is missing" if {
	kagent.config.authorization
	names := {mount.name | some mount in kagent.controller.volumeMounts}
	not names["authorization-ca"]
}

deny contains "controller telemetry differs from the configured signals" if object.get(native_config, "telemetry", null) != kagent.config.telemetry

deny contains "Agent telemetry differs from the configured signals" if object.get(object.get(native_config, "runtimeDefaults", {}), "telemetry", null) != kagent.config.runtimeDefaults.telemetry

deny contains "native Harness release differs from the runtime version" if kagent.config.harnessImages.release != data.test.runtimeVersion

deny contains "the microVM image differs from the deployment pin" if kagent.substrateWorkerPool.workerImage != data.test.microvmImage

deny contains "the controller watches an unrelated namespace" if kagent.global.watchNamespaces != ["agentos"]

deny contains "runtime persistence must use the native controller" if native_config.runtimeDefaults.controlPlaneUrl != "http://kagent-controller.agentos.svc.cluster.local:8083"

deny contains "native Agent cards must advertise the public API origin" if native_config.runtimeDefaults.gatewayUrl != "https://api.example.test"

deny contains "the controller lacks its native Substrate client certificate" if kagent.controller.substrateClientCertificate.enabled != true

deny contains "global image pull secrets mutate immutable initialization Jobs" if object.get(substrate, "imagePullSecrets", []) != []

deny contains "Substrate lacks the native preparation previews" if {gate | some gate in substrate.preview} != {"GoldenEgressPolicy", "PerTemplateSnapshotLocation"}

deny contains "the Substrate router does not admit the native controller" if substrate.atenetRouter.ingressAllowedSPIFFEIDs != ["spiffe://cluster.local/ns/agentos/sa/kagent-controller"]

deny contains "Substrate infrastructure telemetry requires explicit signal configuration" if {
	some signal in {"traces", "metrics", "logs"}
	substrate.otel[signal].enabled != false
}

deny contains "Substrate still renders Atelet outside its own release" if substrate.atelet.enabled != false

deny contains "Atelet lacks the native preparation previews" if {gate | some gate in atelet.preview} != {"GoldenEgressPolicy", "PerTemplateSnapshotLocation"}

deny contains "Atelet does not read the Substrate object store credentials" if atelet.objectStore.credentialsSecret != "substrate-object-store"

provider := yaml.unmarshal(atelet.atelet.imageCredentialProviderConfigYAML).providers[0]

deny contains "credential provider does not cover the configured image registries" if {image | some image in provider.matchImages} != {"registry.example.com", "harness.example.com"}

deny contains "credential provider does not read the current projected response" if provider.args != ["cat", "/run/image-credentials/response.json"]

deny contains "credential provider caches rotated image credentials" if provider.defaultCacheDuration != "0s"

deny contains "native worker pool has the wrong ServiceAccount" if {
	some file in input
	file.contents.kind == "WorkerPool"
	file.contents.spec.template.serviceAccountName != "kagent-workers"
}

deny contains "native worker pool does not reserve three workers" if {
	some file in input
	file.contents.kind == "WorkerPool"
	file.contents.spec.replicas != 3
}
