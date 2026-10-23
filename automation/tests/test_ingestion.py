import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import jwt
import pytest
from agentos.automation.v1.automation_pb2 import (
    CASE_STATE_ACTIVE,
    CASE_STATE_OTHER,
    CASE_STATE_RESOLVED,
    FEEDBACK_DECISION_ACCEPTED,
    AutomationConfig,
    CaseFeedback,
)
from agentos_automation import http as api_module
from agentos_automation.bus import EventBus, source_case
from agentos_automation.http import application
from cloudevents.core.bindings.http import HTTPMessage, from_http_event, to_structured_event
from cloudevents.core.v1.event import CloudEvent
from cryptography.hazmat.primitives.asymmetric import rsa
from google.protobuf.json_format import MessageToDict

ISSUER = "https://id.example.test/realms/operations"
SIGNER = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def config(**values):
    value = AutomationConfig(environment="real", workspace="operations", **values)
    value.trigger.event_namespace = "ops"
    source = value.trigger.source
    source.type_prefix = "alert.lifecycle."
    source.key_field = "alertId"
    source.state_field = "state"
    source.summary_field = "reason"
    source.active_states.extend(["firing", "active"])
    source.resolved_states.append("resolved")
    return value


def source(state="firing", kind="alert.lifecycle.changed", **attributes):
    return to_structured_event(
        CloudEvent(
            {"id": "alert-change-1", "source": "/alerts", "type": kind, **attributes},
            {"alertId": "incident-1", "state": state, "reason": "Interface is down"},
        )
    ).body


def test_cases_follow_the_declared_source_mapping_and_not_the_delivery():
    first = source_case(source(), 10, config())
    assert first == source_case(source(), 10, config())
    assert (first.key, first.version, first.state, first.summary) == (
        "/alerts/incident-1",
        10,
        CASE_STATE_ACTIVE,
        "Interface is down",
    )
    assert source_case(source("RESOLVED"), 11, config()).state == CASE_STATE_RESOLVED
    assert source_case(source("acknowledged"), 12, config()).state == CASE_STATE_OTHER
    for data, reason in [
        (b'{"not": "a CloudEvent"}', "original CloudEvents identity"),
        (source(kind="ticket.changed"), "Unexpected source event"),
        (source(environment="foreign"), "Unexpected source event"),
    ]:
        with pytest.raises(ValueError, match=reason):
            source_case(data, 13, config())


async def test_facts_are_namespaced_durable_and_reuse_their_identity():
    connection = AsyncMock()
    js = AsyncMock()
    connection.jetstream = lambda: js
    bus = EventBus(connection, "real", "ops")
    first = await bus.publish("cases.updated", "case", 10, {"phase": 1})
    assert first == await bus.publish("cases.updated", "case", 10, {"phase": 1})
    event = from_http_event(
        HTTPMessage({"Content-Type": "application/cloudevents+json"}, js.publish.call_args.args[1])
    )
    assert js.publish.call_args.args[0] == event.get_type() == "ops.cases.updated"
    assert event.get_source() == "/ops/real"
    assert event.get_id() == js.publish.call_args.kwargs["headers"]["Nats-Msg-Id"]
    assert event.get_extension("environment") == "real"
    js.publish.side_effect = TimeoutError("No persisted acknowledgement")
    with pytest.raises(TimeoutError):
        await bus.publish("cases.updated", "case", 11, {})


@pytest.fixture
def api(monkeypatch):
    settings = config(
        oidc_issuer=ISSUER,
        oidc_audience="events",
        role_claim="realm_access.roles",
        feedback_role="case-feedback",
    )
    keys = SimpleNamespace(
        get_signing_key_from_jwt=lambda _: SimpleNamespace(key=SIGNER.public_key())
    )
    monkeypatch.setattr(api_module, "signing_keys", lambda issuer: keys)
    bus = AsyncMock()
    bus.publish = AsyncMock(return_value="recorded")
    transport = httpx.ASGITransport(app=application(settings, bus, lambda: True))
    return httpx.AsyncClient(transport=transport, base_url="http://automation"), bus


def human(roles, audience="events"):
    claims = {
        "sub": "operator",
        "iss": ISSUER,
        "aud": audience,
        "exp": int(time.time()) + 300,
        "realm_access": {"roles": roles},
    }
    return {"Authorization": "Bearer " + jwt.encode(claims, SIGNER, algorithm="RS256")}


async def test_feedback_requires_the_configured_audience_and_role_claim(api):
    client, bus = api
    value = CaseFeedback(
        id=str(uuid4()),
        case_key="/alerts/incident-1",
        version=10,
        conclusion_id="task",
        decision=FEEDBACK_DECISION_ACCEPTED,
        actor="forged",
    )
    async with client:
        for headers in [human(["viewer"]), human(["case-feedback"], audience="console")]:
            response = await client.post("/feedback", headers=headers, json=MessageToDict(value))
            assert response.status_code == 403
        response = await client.post(
            "/feedback", headers=human(["case-feedback"]), json=MessageToDict(value)
        )
    assert response.json() == {"id": "recorded"}
    kind, key, version, payload = bus.publish.call_args.args
    assert (kind, key, version, payload["actor"]) == ("feedback.recorded", value.id, 10, "operator")
