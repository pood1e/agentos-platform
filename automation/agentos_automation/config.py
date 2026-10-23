import os
import re
from pathlib import Path

from agentos.automation.v1.automation_pb2 import AutomationConfig
from google.protobuf.json_format import Parse

REQUIRED = [
    "environment",
    "workspace",
    "nats_url",
    "source_stream",
    "source_subject",
    "durable",
    "temporal_address",
    "temporal_namespace",
    "task_queue",
    "platform_url",
]
NAMESPACE = re.compile(r"[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*")


def load_config():
    config = Parse(Path(os.environ["AGENTOS_AUTOMATION_CONFIG"]).read_text(), AutomationConfig())
    for field in REQUIRED:
        if not getattr(config, field):
            raise ValueError(f"Missing automation configuration: {field}")
    oauth = config.platform_oauth
    if not (
        oauth.token_endpoint.startswith("https://") and oauth.client_id and oauth.client_secret_file
    ):
        raise ValueError("Platform access requires source-environment OAuth client credentials")
    if bool(config.nats_user) != bool(config.nats_password_file):
        raise ValueError("NATS user and password file are configured together")
    if config.oidc_issuer and not (
        config.oidc_audience and config.role_claim and config.feedback_role
    ):
        raise ValueError("Human feedback requires an audience, role claim and role")
    trigger, source = config.trigger, config.trigger.source
    if not trigger.agent.name or trigger.agent.namespace not in ("", config.workspace):
        raise ValueError("A case trigger must select an Agent in its workspace")
    if not NAMESPACE.fullmatch(trigger.event_namespace) or not 0 < len(trigger.brief) <= 2000:
        raise ValueError("Invalid case trigger")
    if not (source.type_prefix and source.key_field and source.state_field) or not (
        source.active_states and source.resolved_states
    ):
        raise ValueError("Incomplete case source")
    if {state.casefold() for state in source.active_states} & {
        state.casefold() for state in source.resolved_states
    }:
        raise ValueError("Case states must be either active or resolved")
    if not 60 <= trigger.timeout_seconds <= 7200 or not 0 <= trigger.cooldown_seconds <= 3600:
        raise ValueError("Invalid case execution bounds")
    return config
