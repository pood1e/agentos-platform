import { fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { TaskSchema, TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { type ToolActivity, ToolActivitySchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { redact } from "../../shared/redact.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey } from "../read-model/agents.js";
import { callEntries, toolCalls } from "../read-model/calls.js";

/** Scores are accepted only for completed native work and all its foreground delegations. */
export async function nativeEvaluationProof(
  clients: KagentClients,
  session: Session,
  taskId: string,
  messageId: string,
) {
  const seen = new Set<string>(),
    calls: ToolActivity[] = [];
  async function visit(session: Session, id: string, request: string) {
    if (seen.has(id)) return;
    if (seen.size >= 32)
      throw new ConnectError("Evaluation delegation limit exceeded", Code.ResourceExhausted);
    seen.add(id);
    const task = await clients.a2a.getTask(
      { tenant: agentKey(session.agent), id },
      { timeoutMs: 15_000 },
    );
    if (
      task.contextId !== session.id ||
      task.status?.state !== TaskState.COMPLETED ||
      !task.history.some((message) => message.messageId === request)
    )
      throw new ConnectError(
        "Evaluation task does not match its native context or invocation",
        Code.FailedPrecondition,
      );
    const sanitized = fromJson(TaskSchema, redact(toJson(TaskSchema, task)));
    const entries = callEntries(sanitized, new Map());
    for (const call of toolCalls(sanitized, agentKey(session.agent), new Map())) {
      calls.push(
        fromJson(ToolActivitySchema, {
          id: call.id,
          name: call.name,
          args: call.args ? toJson(ValueSchema, call.args) : null,
          response: {
            outcome:
              call.state === ActivityState.SUCCEEDED
                ? "output"
                : call.state === ActivityState.FAILED
                  ? "error"
                  : "unknown",
          },
        }),
      );
      const reference = entries.find((entry) => entry.id === call.id)?.delegation;
      if (!reference?.sessionId || !reference.messageId) continue;
      const { session: child } = await clients.sessions.getSession(
        { sessionId: reference.sessionId },
        { timeoutMs: 15_000 },
      );
      if (!child)
        throw new ConnectError("Evaluation child context is missing", Code.FailedPrecondition);
      if (!reference.taskId)
        throw new ConnectError(
          "Evaluation delegation did not return a task",
          Code.FailedPrecondition,
        );
      await visit(child, reference.taskId, reference.messageId);
    }
  }
  await visit(session, taskId, messageId);
  return calls;
}
