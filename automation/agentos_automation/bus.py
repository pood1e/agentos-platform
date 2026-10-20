import hashlib
import json

from agentos.automation.v1.automation_pb2 import (
    CASE_STATE_ACTIVE,
    CASE_STATE_OTHER,
    CASE_STATE_RESOLVED,
    CaseSignal,
)
from cloudevents.core.bindings.http import HTTPMessage, from_http_event, to_structured_event
from cloudevents.core.exceptions import CloudEventValidationError
from cloudevents.core.v1.event import CloudEvent
from google.protobuf.json_format import MessageToDict


def identity(*parts):
    return hashlib.sha256("\0".join(map(str, parts)).encode()).hexdigest()


def case_state(value, source):
    state = value.casefold()
    if state in {item.casefold() for item in source.active_states}:
        return CASE_STATE_ACTIVE
    if state in {item.casefold() for item in source.resolved_states}:
        return CASE_STATE_RESOLVED
    return CASE_STATE_OTHER


def source_case(data, sequence, config):
    source = config.trigger.source
    if len(data) > 65536:
        raise ValueError("Source event exceeds its size limit")
    envelope = json.loads(data)
    if not isinstance(envelope, dict) or not all(
        envelope.get(key) for key in ("id", "source", "type", "specversion")
    ):
        raise ValueError("Persisted source events require their original CloudEvents identity")
    try:
        event = from_http_event(HTTPMessage({"Content-Type": "application/cloudevents+json"}, data))
    except CloudEventValidationError as error:
        raise ValueError("Invalid source CloudEvent") from error
    payload = event.get_data()
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get(source.key_field), str)
        or not isinstance(payload.get(source.state_field), str)
    ):
        raise ValueError("Invalid source case event")
    if not event.get_type().startswith(source.type_prefix) or event.get_extension(
        "environment"
    ) not in (None, config.environment):
        raise ValueError("Unexpected source event")
    return CaseSignal(
        key=f"{event.get_source()}/{payload[source.key_field]}",
        event_id=event.get_id(),
        version=sequence,
        state=case_state(payload[source.state_field], source),
        summary=str(payload.get(source.summary_field) or "")[:1000],
        environment=config.environment,
    )


class EventBus:
    """Publishes case facts as CloudEvents under the solution pack's type namespace."""

    def __init__(self, connection, environment, namespace):
        self.connection = connection
        self.js = connection.jetstream()
        self.environment = environment
        self.namespace = namespace

    async def publish(self, kind, key, version, payload):
        kind = f"{self.namespace}.{kind}"
        identifier = identity(self.environment, kind, key, version)
        event = CloudEvent(
            {
                "id": identifier,
                "source": f"/{self.namespace}/{self.environment}",
                "type": kind,
                "subject": key,
                "datacontenttype": "application/json",
                "environment": self.environment,
                "sourceversion": str(version),
            },
            payload,
        )
        data = to_structured_event(event).body
        await self.js.publish(kind, data, headers={"Nats-Msg-Id": identifier}, timeout=15)
        return identifier

    async def evaluation(self, feedback):
        feedback.report.feedback_synchronized = True
        await self.publish(
            "evaluations.completed",
            feedback.candidate_id,
            feedback.report.completed_at.ToNanoseconds(),
            MessageToDict(feedback),
        )
        return feedback.candidate_id
