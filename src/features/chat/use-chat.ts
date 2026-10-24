import { create } from "@bufbuild/protobuf";
import { useMutation } from "@connectrpc/connect-query";
import { useRef, useState } from "react";
import { Role } from "../../../gen/a2a_pb.js";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { ChatMessageSchema } from "../../../gen/agentos/console/v1/conversation_pb.js";
import type { ResourceReference } from "../../../gen/kagent/api/v1/common_pb.js";
import { pendingInteractions } from "../../../shared/conversation-interactions.js";
import { useAccess } from "../../lib/access.js";
import { consoleClient } from "../../lib/console.js";
import { errorKey } from "../../lib/errors.js";
import { useWatch } from "../../lib/use-watch.js";
import { active, awaiting } from "../status/activity.js";

interface Outgoing {
  id: string;
  text: string;
  contextId: string;
}

async function* follow(
  agent: Pick<ResourceReference, "namespace" | "name">,
  contextId: string,
  signal: AbortSignal,
) {
  for await (const { conversation } of consoleClient.watchConversation(
    { agent, contextId },
    { signal },
  ))
    if (conversation) yield conversation;
}

/** One conversation with an assistant role: its live state and the message composer. */
export function useChat(
  agent: Pick<ResourceReference, "namespace" | "name">,
  contextId: string,
  onStarted: (contextId: string) => void,
) {
  const access = useAccess();
  const scope = `${agent.namespace}/${agent.name}:${contextId}`;
  const current = useRef(scope);
  current.current = scope;
  const { value: conversation, error: watchError } = useWatch(
    agent.namespace && agent.name ? `${agent.namespace}/${agent.name}:${contextId}` : undefined,
    (signal) => follow(agent, contextId, signal),
  );
  const send = useMutation(ConsoleService.method.sendMessage);
  const stop = useMutation(ConsoleService.method.cancelTask);
  const [outgoing, setOutgoing] = useState<Outgoing>();
  const history = conversation?.messages ?? [];
  const messages =
    outgoing &&
    outgoing.contextId === contextId &&
    !history.some((message) => message.id === outgoing.id)
      ? [
          ...history,
          create(ChatMessageSchema, {
            id: outgoing.id,
            role: Role.USER,
            parts: [{ id: `text:${outgoing.id}`, content: { case: "text", value: outgoing.text } }],
          }),
        ]
      : history;
  const ready = conversation?.ready ?? false;
  const busy = conversation?.busy ?? false;
  const pending = pendingInteractions(conversation);
  const blocked =
    !access.data || !conversation?.operate || send.isPending || stop.isPending || busy || !ready;

  async function submit(input: string, messageId?: string): Promise<boolean> {
    const text = input.trim();
    if (blocked || !text) return false;
    // A retry of the same failed text keeps its message ID so kagent can deduplicate it.
    const id =
      messageId ??
      (send.isError && outgoing?.contextId === contextId && outgoing.text === text
        ? outgoing.id
        : crypto.randomUUID());
    setOutgoing({ id, text, contextId });
    try {
      const response = await send.mutateAsync({ agent, contextId, messageId: id, text });
      if (current.current !== scope) return true;
      // Stays visible until the conversation stream includes it.
      setOutgoing({ id, text, contextId: response.contextId });
      if (response.contextId !== contextId) onStarted(response.contextId);
      return true;
    } catch {
      return false;
    }
  }

  return {
    conversation,
    outgoing,
    messages,
    ready,
    busy,
    running: conversation?.runs.some((run) => active(run.state) || awaiting(run.state)) ?? false,
    pending,
    blocked,
    sending: send.isPending,
    error: send.error
      ? errorKey(send.error, "chat.sendFailed")
      : stop.error
        ? errorKey(stop.error, "task.cancelFailed")
        : watchError,
    cancel: async (taskId?: string) => {
      const id = taskId ?? messages.findLast((message) => message.role === Role.USER)?.taskId;
      if (id) await stop.mutateAsync({ taskId: id });
    },
    reset: () => {
      setOutgoing(undefined);
      send.reset();
    },
    submit,
  };
}

export type Chat = ReturnType<typeof useChat>;
