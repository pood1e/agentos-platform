import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { MessageSchema, Role } from "../../gen/a2a_pb.js";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import type {
  RespondInteractionRequest,
  SendMessageRequest,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import { InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import {
  AskUserResponseSchema,
  ToolApprovalResponseSchema,
} from "../../gen/kagent/api/v1/interactions_pb.js";
import { shortTitle } from "../../shared/title.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey } from "../read-model/agents.js";
import { hitlExtension, hitlReply } from "../read-model/decode/hitl.js";
import { timelineKey } from "../read-model/decode/messages.js";
import { ingest } from "../read-model/entry.js";
import type { TaskQueries } from "../read-model/queries.js";
import { awaiting } from "../read-model/state.js";
import { fail, invalid, notFound, precondition, unavailable } from "../shared/errors.js";
import { messageIdentity } from "../shared/idempotency.js";

export function messageCommands(
  projection: TaskQueries,
  clients: KagentClients,
  namespace: string,
  authorizeTools?: (
    session: import("../../gen/kagent/api/v1/sessions_pb.js").Session,
    tools: string[],
  ) => Promise<void>,
) {
  async function target(request: SendMessageRequest, identity: UserIdentity) {
    const ref = request.agent;
    if (!ref?.name || ref.namespace !== namespace) throw invalid("chat.invalidConversation");
    const id = agentKey(ref);
    if (request.contextId) {
      const { session: native } = await clients.sessions.getSession({
        sessionId: request.contextId,
      });
      if (!native) throw fail(Code.PermissionDenied, "chat.executionDenied");
      const session = await projection.session(request.contextId);
      if (!session || session.agentId !== id) throw precondition("chat.invalidConversation");
      return { agentId: session.agentId, contextId: session.id };
    }
    const agent = await projection.agent(id);
    if (!agent?.ready) throw fail(Code.Unavailable, "chat.notReady");
    const [agentNamespace = "", name = ""] = agent.id.split("/");
    const { session } = await clients.sessions.createSession(
      {
        agent: { namespace: agentNamespace, name },
        requestId: messageIdentity(
          "chat",
          agentNamespace,
          name,
          identity.subject,
          request.messageId,
        ),
        name: shortTitle(request.text),
      },
      { timeoutMs: 30_000 },
    );
    if (!session) throw unavailable();
    return { agentId: agentKey(session.agent), contextId: session.id };
  }

  async function send(request: SendMessageRequest, identity: UserIdentity) {
    const text = request.text.trim();
    if (!text) throw invalid("chat.invalidMessage");
    const { agentId, contextId } = await target(request, identity);
    const dispatch = () =>
      projection.send(
        agentId,
        create(MessageSchema, {
          messageId: request.messageId,
          contextId,
          role: Role.USER,
          parts: [{ content: { case: "text", value: text } }],
          extensions: [hitlExtension],
          metadata: {
            [timelineKey]: new Date().toISOString(),
            "agentos.initiator": identity.subject,
          },
        }),
      );
    const task = await dispatch();
    return { contextId: task.contextId, taskId: task.id };
  }

  async function respond(request: RespondInteractionRequest) {
    const entry = await projection.entry(request.taskId);
    if (!entry) throw notFound("interaction.stale");
    const { session } = await clients.sessions.getSession({ sessionId: entry.contextId });
    if (!session) throw fail(Code.PermissionDenied, "chat.executionDenied");

    const task = await clients.a2a.getTask(
      { tenant: entry.agentId, id: request.taskId },
      { timeoutMs: 10_000 },
    );
    const fresh = ingest(task, entry.agentId);
    const pending = fresh.interactions.find(
      (item) => item.requestId === request.requestId && awaiting(item.state),
    );
    if (!pending) throw precondition("interaction.stale");
    const decision = request.decision;
    const target = { taskId: task.id, contextId: task.contextId };
    if (pending.kind === InteractionKind.APPROVAL && decision.case === "approval") {
      if (authorizeTools && decision.value.approvals.some((item) => item.approved)) {
        const { session } = await clients.sessions.getSession({ sessionId: entry.contextId });
        if (!session) throw fail(Code.PermissionDenied, "approval.executionDenied");
        await authorizeTools(
          session,
          pending.tools
            .filter((tool) =>
              decision.value.approvals.some((item) => item.id === tool.id && item.approved),
            )
            .map((tool) => tool.name),
        );
      }
      const decisions = decision.value.approvals;
      const ids = new Set(decisions.map((item) => item.id));
      if (
        decisions.length !== pending.tools.length ||
        ids.size !== decisions.length ||
        pending.tools.some((tool) => !ids.has(tool.id))
      )
        throw invalid("interaction.invalidAnswer");
      await projection.send(
        entry.agentId,
        hitlReply(
          target,
          randomUUID(),
          {
            type: "tool_approval_response",
            value: create(ToolApprovalResponseSchema, { approvals: decisions }),
          },
          "The user responded to the tool confirmation",
        ),
      );
      return {};
    }
    if (pending.kind === InteractionKind.QUESTION && decision.case === "answer") {
      const answers = decision.value.answers;
      const valid =
        answers.length === pending.questions.length &&
        answers.every(
          (answer, position) =>
            answer.values.length > 0 &&
            answer.values.every((value) => value.trim()) &&
            (pending.questions[position]?.multiple || answer.values.length === 1),
        );
      if (!valid) throw invalid("interaction.invalidAnswer");
      await projection.send(
        entry.agentId,
        hitlReply(
          target,
          randomUUID(),
          {
            type: "ask_user_response",
            value: create(AskUserResponseSchema, {
              id: pending.requestId,
              answers: answers.map((answer) => ({ answer: answer.values })),
            }),
          },
          answers.map((answer) => answer.values.join(", ")).join("\n"),
        ),
      );
      return {};
    }
    throw invalid("interaction.invalidAnswer");
  }

  return { send, respond };
}
