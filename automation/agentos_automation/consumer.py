from agentos.automation.v1.automation_pb2 import CaseWorkflowInput
from nats.errors import TimeoutError
from temporalio.common import WorkflowIDConflictPolicy

from .bus import identity, source_case
from .workflow import CaseWorkflow


async def consume(config, bus, temporal):
    consumer = await bus.js.consumer_info(config.source_stream, config.durable)
    if consumer.config.filter_subject != config.source_subject:
        raise ValueError("Source consumer subject differs from its configured authority")
    subscription = await bus.js.pull_subscribe_bind(
        stream=config.source_stream, durable=config.durable
    )
    while True:
        try:
            messages = await subscription.fetch(16, timeout=2)
        except TimeoutError:
            continue
        for message in messages:
            try:
                signal = source_case(message.data, message.metadata.sequence.stream, config)
            except (ValueError, KeyError, TypeError):
                await bus.publish(
                    "ingestion.invalid",
                    identity(message.data),
                    message.metadata.sequence.stream,
                    {"reason": "invalid_source_event"},
                )
                await message.ack_sync(timeout=15)
                continue
            await temporal.start_workflow(
                CaseWorkflow.run,
                CaseWorkflowInput(
                    key=signal.key,
                    environment=config.environment,
                    timeout_seconds=config.trigger.timeout_seconds,
                    cooldown_seconds=config.trigger.cooldown_seconds,
                ),
                id="case-" + identity(config.environment, signal.key),
                task_queue=config.task_queue,
                id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
                start_signal="accept",
                start_signal_args=[signal],
            )
            await message.ack_sync(timeout=15)
