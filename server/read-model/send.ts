import type { Message, StreamResponse, Task } from "../../gen/a2a_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { hitlExtension } from "./decode/hitl.js";
import { applyEvent } from "./events.js";

/** Accepts the first task frame, then transfers the remaining stream to the synchronizer. */
export async function openMessage(
  clients: KagentClients,
  tenant: string,
  message: Message,
  baseline: Task | undefined,
  lifetime: AbortSignal,
  headers: Record<string, string> = {},
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, lifetime]);
  const stream = clients.a2a.sendStreamingMessage(
    { tenant, message },
    { signal, timeoutMs: 30 * 60_000, headers: { ...headers, "A2A-Extensions": hitlExtension } },
  );
  const iterator = stream[Symbol.asyncIterator]();
  const timeout = setTimeout(() => controller.abort(new Error("kagent task timeout")), 30_000);
  try {
    let task: Task | undefined;
    while (!task) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.payload.case === "task" || baseline) task = applyEvent(baseline, next.value);
    }
    if (
      !task ||
      task.contextId !== message.contextId ||
      (message.taskId && task.id !== message.taskId)
    )
      throw new Error("kagent did not return a traceable A2A task");
    if (!task.history.some((item) => item.messageId === message.messageId))
      task.history.push(message);
    return {
      task,
      controller,
      events: { [Symbol.asyncIterator]: () => iterator } satisfies AsyncIterable<StreamResponse>,
    };
  } catch (error) {
    controller.abort();
    await iterator.return?.();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
