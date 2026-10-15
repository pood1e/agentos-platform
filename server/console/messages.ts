import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { MessageSchema, Role } from "../../gen/a2a_pb.js";
import type {
  RespondInteractionRequest,
  SendMessageRequest,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import { InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import { AskUserResponseSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey, sessionInfo } from "../read-model/agents.js";
import { hitlExtension, hitlReply } from "../read-model/decode/hitl.js";
import { timelineKey } from "../read-model/decode/messages.js";
import { ingest } from "../read-model/entry.js";
import { awaiting, terminal } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { conversation, conversationRole } from "../read-model/views/conversation.js";
import { shortTitle } from "../read-model/views/title.js";
import { conflict, fail, invalid, notFound, precondition, unavailable } from "../shared/errors.js";

export function messageCommands(sync: KagentSync, clients: KagentClients) {
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

  async function target(request: SendMessageRequest) {
    const role = conversationRole(request.kind);
    if (request.contextId) {
      const session = index.session(request.contextId);
      if (!session || index.roleOf(session.agentId) !== role)
        throw precondition("chat.invalidConversation");
      const view = await conversation(sync, request.kind, request.contextId);
      if (view.pending.length) throw precondition("chat.pendingApproval");
      if (view.busy) throw conflict("chat.busy");
      return { agentId: session.agentId, contextId: session.id };
    }
    const candidates = index
      .agents()
      .filter((agent) => agent.role === role && agent.ready)
      .map((agent) => ({
        agent,
        load: index.agentEntries(agent.id).filter((entry) => !terminal(entry.state)).length,
      }))
      .sort((a, b) => a.load - b.load || a.agent.id.localeCompare(b.agent.id));
    const agent = candidates[0]?.agent;
    if (!agent) throw fail(Code.Unavailable, "chat.notReady");
    const [namespace = "", name = ""] = agent.id.split("/");
    const { session } = await clients.sessions.createSession(
      { agent: { namespace, name }, requestId: request.messageId, name: shortTitle(request.text) },
      { timeoutMs: 30_000 },
    );
    if (!session) throw unavailable();
    index.setSession(sessionInfo(session));
    return { agentId: agentKey(session.agent), contextId: session.id };
  }

  async function send(request: SendMessageRequest) {
    const text = request.text.trim();
    if (!text) throw invalid("chat.invalidMessage");
    return exclusive(request.contextId || request.messageId, async () => {
      const accepted = index.taskOfMessage(request.messageId);
      if (accepted) return { contextId: accepted.contextId, taskId: accepted.id };
      const { agentId, contextId } = await target(request);
      const task = await sync.send(
        agentId,
        create(MessageSchema, {
          messageId: request.messageId,
          contextId,
          role: Role.USER,
          parts: [{ content: { case: "text", value: text } }],
          extensions: [hitlExtension],
          metadata: { [timelineKey]: new Date().toISOString() },
        }),
      );
      return { contextId: task.contextId, taskId: task.id };
    });
  }

  async function respond(request: RespondInteractionRequest) {
    const entry = index.entry(request.taskId);
    if (!entry) throw notFound("interaction.stale");
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
