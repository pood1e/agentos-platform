from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

with workflow.unsafe.imports_passed_through():
    from agentos.automation.v1.automation_pb2 import (
        CASE_PHASE_CONCLUSION,
        CASE_PHASE_ESCALATED,
        CASE_PHASE_RECEIVED,
        CASE_PHASE_SOURCE_RESOLVED,
        CASE_STATE_ACTIVE,
        CASE_STATE_RESOLVED,
        CaseSignal,
        CaseWorkflowInput,
    )

TERMINAL = [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_FAILED",
    "TASK_STATE_REJECTED",
]


@workflow.defn
class CaseWorkflow:
    def __init__(self):
        self.pending = []
        self.seen = set()
        self.version = 0

    @workflow.signal
    def accept(self, signal: CaseSignal):
        if signal.event_id in self.seen or signal.version <= self.version:
            return
        self.seen.add(signal.event_id)
        self.pending.append(signal)

    async def activity(self, name, value, limit_seconds=60):
        return await workflow.execute_activity(
            name,
            value,
            start_to_close_timeout=timedelta(seconds=limit_seconds),
            schedule_to_close_timeout=timedelta(seconds=limit_seconds),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

    async def publish(self, kind, signal, version, phase, result=None):
        await self.activity(
            "publish_case",
            {
                "type": kind,
                "key": signal.key,
                "version": version,
                "data": {
                    "environment": signal.environment,
                    "sourceVersion": str(signal.version),
                    "phase": phase,
                    "native": result or {},
                },
            },
        )

    async def fact(self, signal, phase, result=None):
        await self.publish("cases.updated", signal, signal.version * 10 + phase, phase, result)

    async def finding(self, kind, signal, phase, result=None):
        await self.publish(kind, signal, signal.version, phase, result)

    @workflow.run
    async def run(self, config: CaseWorkflowInput):
        self.version = config.last_version
        self.seen.update(config.seen_events)
        while True:
            await workflow.wait_condition(lambda: bool(self.pending))
            signal = self.pending.pop(0)
            if signal.version <= self.version:
                continue
            self.version = signal.version
            reference = {"key": signal.key, "version": signal.version, "summary": signal.summary}
            if signal.state == CASE_STATE_RESOLVED:
                await self.fact(signal, CASE_PHASE_SOURCE_RESOLVED)
                continue
            await self.fact(signal, CASE_PHASE_RECEIVED)
            if signal.state != CASE_STATE_ACTIVE:
                continue
            deadline = workflow.now() + timedelta(seconds=config.timeout_seconds)
            result = None
            try:
                result = await self.activity(
                    "run_case", reference, min(config.timeout_seconds, 620)
                )
                while result.get("state") not in TERMINAL:
                    if workflow.now() >= deadline:
                        raise TimeoutError("Native case exceeded its deadline")
                    await workflow.sleep(15)
                    result = await self.activity("observe_case", reference)
                completed = result.get("state") == "TASK_STATE_COMPLETED"
                phase = CASE_PHASE_CONCLUSION if completed else CASE_PHASE_ESCALATED
                await self.fact(signal, phase, result)
                if completed:
                    await self.finding("findings.proposed", signal, phase, result)
            except (ActivityError, TimeoutError):
                try:
                    await self.activity("cancel_case", reference)
                except ActivityError:
                    workflow.logger.warning("Native case cancellation remains unconfirmed")
                await self.fact(signal, CASE_PHASE_ESCALATED, result)
                await self.finding("findings.escalated", signal, CASE_PHASE_ESCALATED)
            await workflow.sleep(config.cooldown_seconds)
            if workflow.info().is_continue_as_new_suggested() and not self.pending:
                config.last_version = self.version
                config.seen_events[:] = sorted(self.seen)[-1024:]
                workflow.continue_as_new(config)
