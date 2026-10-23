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

controller_version := trim(label.Value[index + 1], "\"") if {
	some file in input
	endswith(file.path, "runtime/kagent/Dockerfile")
	some label in file.contents
	label.Cmd == "label"
	some index, value in label.Value
	value == "org.opencontainers.image.version"
}

deny contains "native Harness release differs from the controller image" if kagent.config.harnessImages.release != controller_version

deny contains "controller image lacks its release label" if not controller_version

deny contains "the microVM image differs from the deployment pin" if kagent.substrateWorkerPool.workerImage != data.test.microvmImage

deny contains "the controller watches an unrelated namespace" if kagent.global.watchNamespaces != ["agentos"]

deny contains "runtime persistence bypasses the platform authorization service" if kagent.config.runtimeDefaults.controlPlaneUrl != "http://agentos-console.agentos.svc.cluster.local:9091"

deny contains "the controller lacks its native Substrate client certificate" if kagent.controller.substrateClientCertificate.enabled != true

deny contains "global image pull secrets mutate immutable initialization Jobs" if object.get(substrate, "imagePullSecrets", []) != []

provider := yaml.unmarshal(substrate.atelet.imageCredentialProviderConfigYAML).providers[0]

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
