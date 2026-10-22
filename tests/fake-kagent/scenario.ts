import { randomUUID } from "node:crypto";
import { clone, create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { type Task, TaskSchema, TaskState, TaskStatusSchema } from "../../gen/a2a_pb.js";
import { SessionSchema } from "../../gen/kagent/api/v1/sessions_pb.js";
import { hitlPayload } from "../../server/read-model/decode/hitl.js";
import { toolEvent, toolOutcome } from "../../server/read-model/decode/tools.js";
import { fixtureIds, fixtureSessions, fixtureTasks } from "../fixtures/kagent.js";

/** The approved remediation as it looked while its native approval was still pending. */
export function awaitingApproval(task: Task, now = Date.now()): Task {
  const pending = clone(TaskSchema, task);
  const request = pending.history.findIndex(
    (message) => hitlPayload(message)?.type === "tool_approval_request",
  );
  const message = pending.history[request];
  const approval = hitlPayload(message);
  const callIds = new Set(
    approval?.type === "tool_approval_request"
      ? (approval.value.nested?.tools ?? approval.value.tools).map((tool) => tool.callId)
      : [],
  );
  pending.history = pending.history.slice(0, request + 1);
  const parts = pending.artifacts.flatMap((artifact) =>
    artifact.parts.map((part) => ({ artifact, part })),
  );
  const marker = parts.findIndex(({ part }) => {
    const event = toolEvent(part);
    return (
      event?.kind === "function_response" &&
      callIds.has(event.id) &&
      toolOutcome(event.response).kind === "error"
    );
  });
  const kept = new Set(parts.slice(0, marker + 1).map(({ part }) => part));
  pending.artifacts = pending.artifacts
    .map((artifact) => ({ ...artifact, parts: artifact.parts.filter((part) => kept.has(part)) }))
    .filter((artifact) => artifact.parts.length);
  pending.status = create(TaskStatusSchema, {
    state: TaskState.INPUT_REQUIRED,
    message,
    timestamp: timestampFromMs(now),
  });
  return pending;
}

/** Recorded tasks with the approval tree paused before the human decision. */
export function pendingApprovalTasks(): Task[] {
  const later = new Set([
    fixtureIds.approvalContinuation,
    fixtureIds.question,
    fixtureIds.approvalFinal,
  ]);
  return fixtureTasks()
    .filter((task) => !later.has(task.id))
    .map((task) => (task.id === fixtureIds.approved ? awaitingApproval(task) : task));
}

/** Each browser scenario owns distinct native IDs, including causal references. */
export function freshScenario() {
  const ids = new Map<string, string>();
  const rewrite = (value: string) =>
    value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
      if (!ids.has(id)) ids.set(id, randomUUID());
      return ids.get(id) ?? id;
    });
  return {
    sessions: fixtureSessions().map((session) =>
      fromJsonString(SessionSchema, rewrite(toJsonString(SessionSchema, session))),
    ),
    tasks: pendingApprovalTasks().map((task) => {
      const restored = fromJsonString(TaskSchema, rewrite(toJsonString(TaskSchema, task)));
      if (restored.status) restored.status.timestamp = timestampFromMs(Date.now());
      return restored;
    }),
    ids: Object.fromEntries(Object.entries(fixtureIds).map(([key, id]) => [key, rewrite(id)])),
  };
}

/** Recorded tasks after the decision, before the coordinator was told about it. */
export function decidedTasks(): Task[] {
  const later = new Set([
    fixtureIds.approvalContinuation,
    fixtureIds.question,
    fixtureIds.approvalFinal,
  ]);
  return fixtureTasks().filter((task) => !later.has(task.id));
}

/** Additional read-only inspection operations with distinct sessions. */
export function syntheticOperations(count: number) {
  const template = fixtureTasks().find((task) => task.id === fixtureIds.inspection);
  const owner = fixtureSessions().find((session) => session.id === template?.contextId);
  if (!template || !owner) throw new Error("inspection fixture missing");
  const sessions = Array.from({ length: count }, (_, index) =>
    create(SessionSchema, { ...owner, id: `synthetic-session-${index}`, name: `巡检 ${index}` }),
  );
  const tasks = sessions.map((session, index) => {
    const task = clone(TaskSchema, template);
    task.id = `synthetic-task-${index}`;
    task.contextId = session.id;
    if (task.status) task.status.timestamp = timestampFromMs(Date.now() + index);
    task.history = task.history.map((message) => ({
      ...message,
      messageId: `${message.messageId}-${index}`,
      contextId: session.id,
      taskId: task.id,
      parts: [
        { ...message.parts[0], content: { case: "text", value: `巡检第 ${index} 组工作负载` } },
      ],
    })) as typeof task.history;
    return task;
  });
  return { sessions, tasks };
}
