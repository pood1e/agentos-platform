package runtime_tests

import rego.v1

telemetry_fixture := {"traces": {"endpoint": "https://collector.example.test:4317", "protocol": "grpc"}}

test_controller_dropped_signal_is_rejected if {
	settings := {"config": {"telemetry": telemetry_fixture, "runtimeDefaults": {"telemetry": telemetry_fixture}}}
	native := {"telemetry": {}, "runtimeDefaults": {"telemetry": telemetry_fixture}}
	messages := deny with kagent as settings with native_config as native
	"controller telemetry differs from the configured signals" in messages
}

test_agent_dropped_signal_is_rejected if {
	settings := {"config": {"telemetry": telemetry_fixture, "runtimeDefaults": {"telemetry": telemetry_fixture}}}
	native := {"telemetry": telemetry_fixture, "runtimeDefaults": {"telemetry": {}}}
	messages := deny with kagent as settings with native_config as native
	"Agent telemetry differs from the configured signals" in messages
}
