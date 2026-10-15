import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { MessageSchema, Role } from "../../gen/a2a_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import type { nativeInvocation } from "../kagent/invoke-session.js";
import { agentInfo } from "../read-model/agents.js";
import { partsText } from "../read-model/decode/messages.js";

export const coordinatorRole = "coordinator";

/** The chat entry point delegates only to the workspace coordinator, found by its role label. */
export function coordinatorDelegation(
  clients: KagentClients,
  namespace: string,
  invoke: ReturnType<typeof nativeInvocation>,
) {
  const coordinator = async (signal?: AbortSignal) => {
    const { agents } = await clients.agents.listAgents(
      { namespace },
      { timeoutMs: 10_000, signal },
    );
    const matches = agents.filter((agent) => agentInfo(agent).role === coordinatorRole);
    if (matches.length !== 1) throw new Error("The workspace requires exactly one coordinator");
    const ref = matches[0]?.ref;
    return ref && { namespace: ref.namespace, name: ref.name };
  };
  return async (args: JsonValue, signal?: AbortSignal) => {
    const message = fromJson(MessageSchema, args);
    const text = partsText(message.parts);
    if (!message.messageId || message.role !== Role.USER || message.taskId || !text)
      throw new Error("Delegation requires a user message, messageId and task text");
    let session = message.contextId
      ? (
          await clients.sessions.getSession(
            { sessionId: message.contextId },
            { timeoutMs: 10_000, signal },
          )
        ).session
      : undefined;
    const ref = message.contextId ? session?.agent : await coordinator(signal);
    if (ref?.namespace !== namespace)
      throw new Error("Delegate only to a coordinator in this workspace");
    const { agent } = await clients.agents.getAgent({ ref }, { timeoutMs: 10_000, signal });
    if (!agent || agentInfo(agent).role !== coordinatorRole)
      throw new Error("Delegate only to a coordinator in this workspace");
    session ??= (
      await clients.sessions.createSession(
        { agent: ref, requestId: message.messageId },
        { timeoutMs: 60_000, signal },
      )
    ).session;
    if (!session) throw new Error("kagent did not return a coordinator session");
    return invoke(session.id, message.messageId, text, signal);
  };
}
