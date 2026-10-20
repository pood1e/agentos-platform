import asyncio
from uuid import uuid4

import pytest
from agentos.automation.v1.automation_pb2 import (
    CASE_PHASE_SOURCE_RESOLVED,
    CASE_STATE_ACTIVE,
    CASE_STATE_RESOLVED,
    CaseSignal,
    CaseWorkflowInput,
)
from agentos_automation.workflow import CaseWorkflow
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker


async def until(changed, condition):
    async with asyncio.timeout(15):
        async with changed:
            await changed.wait_for(condition)


def signal(key, event_id, version, state=CASE_STATE_ACTIVE):
    return CaseSignal(key=key, environment="real", event_id=event_id, version=version, state=state)


@pytest.mark.timeout(120)
async def test_durable_case_deduplication_worker_restart_late_events_and_timeout_cancellation():
    runs, canceled, facts = [], [], []
    changed = asyncio.Condition()

    @activity.defn(name="run_case")
    async def run_case(reference):
        async with changed:
            runs.append(reference["key"])
            changed.notify_all()
        return {
            "state": "TASK_STATE_WORKING"
            if reference["key"] == "timeout"
            else "TASK_STATE_COMPLETED"
        }

    @activity.defn(name="observe_case")
    async def observe_case(_reference):
        return {"state": "TASK_STATE_WORKING"}

    @activity.defn(name="cancel_case")
    async def cancel_case(reference):
        canceled.append(reference["key"])

    @activity.defn(name="publish_case")
    async def publish_case(fact):
        async with changed:
            facts.append(fact)
            changed.notify_all()
        return "persisted"

    async with await WorkflowEnvironment.start_time_skipping() as env:
        queue = "case-test-" + str(uuid4())
        options = {
            "task_queue": queue,
            "max_cached_workflows": 0,
            "workflows": [CaseWorkflow],
            "activities": [run_case, observe_case, cancel_case, publish_case],
        }
        async with Worker(env.client, **options):
            handle = await env.client.start_workflow(
                CaseWorkflow.run,
                CaseWorkflowInput(key="incident", environment="real", timeout_seconds=60),
                id=str(uuid4()),
                task_queue=queue,
            )
            await handle.signal(CaseWorkflow.accept, signal("incident", "source-1", 1))
            await until(changed, lambda: any(f["type"] == "findings.proposed" for f in facts))
        async with Worker(env.client, **options):
            await handle.signal(CaseWorkflow.accept, signal("incident", "source-1", 1))
            await handle.signal(
                CaseWorkflow.accept, signal("incident", "source-3", 3, CASE_STATE_RESOLVED)
            )
            await handle.signal(CaseWorkflow.accept, signal("incident", "source-2", 2))
            await until(
                changed,
                lambda: any(f["data"]["phase"] == CASE_PHASE_SOURCE_RESOLVED for f in facts),
            )
            assert runs == ["incident"]
            timeout = await env.client.start_workflow(
                CaseWorkflow.run,
                CaseWorkflowInput(key="timeout", environment="real", timeout_seconds=60),
                id=str(uuid4()),
                task_queue=queue,
            )
            await timeout.signal(CaseWorkflow.accept, signal("timeout", "timeout-1", 1))
            await until(changed, lambda: "timeout" in runs)
            await env.sleep(90)
            await until(changed, lambda: any(f["type"] == "findings.escalated" for f in facts))
            assert canceled == ["timeout"]
            await handle.cancel()
            await timeout.cancel()
