import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { MessageSchema, Role } from "../../gen/a2a_pb.js";
import type {
  RespondInteractionRequest,
  SendMessageRequest,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import { InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import {
  AskUserResponseSchema,
  ToolApprovalResponseSchema,
} from "../../gen/agentos/kagent/v1/wire_pb.js";
import { shortTitle } from "../../shared/title.js";
import type { Executions } from "../authorization/executions.js";
import { approvalEnvironment } from "../governance/client.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey, sessionInfo } from "../read-model/agents.js";
import { hitlExtension, hitlReply } from "../read-model/decode/hitl.js";
import { timelineKey } from "../read-model/decode/messages.js";
import { ingest } from "../read-model/entry.js";
import { awaiting } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { conversation } from "../read-model/views/conversation.js";
import { conflict, fail, invalid, notFound, precondition, unavailable } from "../shared/errors.js";
import { messageIdentity } from "../shared/idempotency.js";

export function messageCommands(
  sync: KagentSync,
  clients: KagentClients,
  governance?: GovernanceConfig,
  executions?: Executions,
  authorizeTools?: (
    session: import("../../gen/kagent/api/v1alpha1/sessions_pb.js").Session,
    tools: string[],
  ) => Promise<void>,
) {
  const index = sync.index;
  const inflight = new Set<string>();

  async function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (inflight.has(key)) throw conflict("chat.busy");
    inflight.add(key);
    try {
      return await run();
    } finally {
      inflight.delete(key);
    }
  }

  async function target(request: SendMessageRequest, identity?: ExecutionIdentity) {
    const ref = request.agent;
    if (!ref?.name || ref.namespace !== sync.namespace) throw invalid("chat.invalidConversation");
    const id = agentKey(ref);
    if (request.contextId) {
      if (executions) {
        const { session } = await clients.sessions.getSession({ sessionId: request.contextId });
        if (!session || !identity) throw fail(Code.PermissionDenied, "chat.executionDenied");
        await executions.own(session, identity);
      }
      const session = index.session(request.contextId);
      if (!session || session.agentId !== id) throw precondition("chat.invalidConversation");
      const view = await conversation(sync, ref, request.contextId);
      if (view.pending.length) throw precondition("chat.pendingApproval");
      if (view.busy) throw conflict("chat.busy");
      return { agentId: session.agentId, contextId: session.id };
    }
    const agent = index.agent(id);
    if (!agent?.ready) throw fail(Code.Unavailable, "chat.notReady");
    const [namespace = "", name = ""] = agent.id.split("/");
    if (executions && !identity) throw fail(Code.PermissionDenied, "chat.executionDenied");
    const { session } = await clients.sessions.createSession(
      {
        agent: { namespace, name },
        requestId: messageIdentity(
          "chat",
          namespace,
          name,
          identity?.subject ?? "console",
          request.messageId,
        ),
        name: shortTitle(request.text),
      },
      { timeoutMs: 30_000 },
    );
    if (!session) throw unavailable();
    if (executions) {
      if (!identity) throw fail(Code.PermissionDenied, "chat.executionDenied");
      await executions.bind(session, identity);
    }
    index.setSession(sessionInfo(session));
    return { agentId: agentKey(session.agent), contextId: session.id };
  }

  async function send(request: SendMessageRequest, identity?: ExecutionIdentity) {
    const text = request.text.trim();
    if (!text) throw invalid("chat.invalidMessage");
    return exclusive(request.contextId || request.messageId, async () => {
      const accepted = index.taskOfMessage(request.messageId);
      if (accepted) {
        if (executions) {
          const { session } = await clients.sessions.getSession({ sessionId: accepted.contextId });
          if (!session || !identity) throw fail(Code.PermissionDenied, "chat.executionDenied");
          await executions.own(session, identity);
        }
        return { contextId: accepted.contextId, taskId: accepted.id };
      }
      const { agentId, contextId } = await target(request, identity);
      const task = await sync.send(
        agentId,
        create(MessageSchema, {
          messageId: request.messageId,
          contextId,
          role: Role.USER,
          parts: [{ content: { case: "text", value: text } }],
          extensions: [hitlExtension],
          metadata: {
            [timelineKey]: new Date().toISOString(),
            ...(identity ? { "agentos.initiator": identity.subject } : {}),
          },
        }),
      );
      return { contextId: task.contextId, taskId: task.id };
    });
  }

  async function respond(request: RespondInteractionRequest, identity?: ExecutionIdentity) {
    const entry = index.entry(request.taskId);
    if (!entry) throw notFound("interaction.stale");
    if (executions) {
      const { session } = await clients.sessions.getSession({ sessionId: entry.contextId });
      if (!session || !identity) throw fail(Code.PermissionDenied, "chat.executionDenied");
      await executions.own(session, identity);
    }
    return exclusive(request.taskId, async () => {
      const task = await clients.a2a.getTask(
        { tenant: entry.agentId, id: request.taskId },
        { timeoutMs: 10_000 },
      );
      const fresh = ingest(task, entry.agentId);
      index.upsert(fresh);
      index.flush();
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
        if (
          pending.tools.some(
            (tool) => approvalEnvironment(governance?.environments ?? [], tool.name)?.approvalUrl,
          )
        )
          throw precondition("approval.externalDecision");
        const decisions = decision.value.approvals;
        const ids = new Set(decisions.map((item) => item.id));
        if (
          decisions.length !== pending.tools.length ||
          ids.size !== decisions.length ||
          pending.tools.some((tool) => !ids.has(tool.id))
        )
          throw invalid("interaction.invalidAnswer");
        await sync.send(
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
        await sync.send(
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
    });
  }

  return { send, respond };
}
