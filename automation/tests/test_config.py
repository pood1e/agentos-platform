import pytest
from agentos.automation.v1.automation_pb2 import AutomationConfig
from agentos_automation.config import REQUIRED, load_config
from google.protobuf.json_format import MessageToJson, ParseDict

TRIGGER = {
    "eventNamespace": "ops",
    "source": {
        "typePrefix": "alert.lifecycle.",
        "keyField": "alertId",
        "stateField": "state",
        "activeStates": ["firing"],
        "resolvedStates": ["resolved"],
    },
    "brief": "Triage the case. Context: ${summary}",
    "timeoutSeconds": 900,
    "cooldownSeconds": 300,
}


def load(tmp_path, monkeypatch, change=lambda value: None):
    value = AutomationConfig(**{field: f"{field}-value" for field in REQUIRED})
    ParseDict(TRIGGER, value.trigger)
    change(value)
    path = tmp_path / "automation.json"
    path.write_text(MessageToJson(value))
    monkeypatch.setenv("AGENTOS_AUTOMATION_CONFIG", str(path))
    return load_config()


def test_a_complete_trigger_is_accepted(tmp_path, monkeypatch):
    assert load(tmp_path, monkeypatch).trigger.source.key_field == "alertId"


@pytest.mark.parametrize(
    "change",
    [
        lambda value: value.ClearField("durable"),
        lambda value: setattr(value, "nats_user", "automation"),
        lambda value: setattr(value.trigger, "event_namespace", "Ops Events"),
        lambda value: value.trigger.ClearField("brief"),
        lambda value: value.trigger.source.ClearField("key_field"),
        lambda value: value.trigger.source.resolved_states.append("FIRING"),
        lambda value: setattr(value.trigger, "timeout_seconds", 30),
        lambda value: setattr(value, "oidc_issuer", "https://id.example.test"),
    ],
)
def test_incomplete_or_ambiguous_configuration_is_rejected(tmp_path, monkeypatch, change):
    with pytest.raises(ValueError):
        load(tmp_path, monkeypatch, change)
