import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { type Message, SendMessageConfigurationSchema, type Task } from "../../gen/a2a_pb.js";
import { ErrorInfoSchema } from "../../gen/google/rpc/error_details_pb.js";
import type { KagentClients } from "./clients.js";

const rejected = (error: unknown) =>
  error instanceof ConnectError &&
  error.code === Code.FailedPrecondition &&
  error
    .findDetails(ErrorInfoSchema)
    .some(
      (info) =>
        info.domain === "a2a-protocol.org" &&
        info.reason === "UNSUPPORTED_OPERATION" &&
        info.metadata.reason === "KAGENT_SEND_NOT_ACCEPTED",
    );

/** Returns the accepted task immediately; retries only native proof that no input was accepted. */
export async function acceptMessage(
  client: Pick<KagentClients["a2a"], "sendMessage">,
  tenant: string,
  message: Message,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Task> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await client.sendMessage(
        {
          tenant,
          message,
          configuration: create(SendMessageConfigurationSchema, { returnImmediately: true }),
        },
        { timeoutMs: 30_000, headers, signal },
      );
      const task = response.payload.case === "task" ? response.payload.value : undefined;
      if (
        !task ||
        task.contextId !== message.contextId ||
        (message.taskId && task.id !== message.taskId)
      )
        throw new Error("kagent did not return a traceable A2A task");
      if (!task.history.some((item) => item.messageId === message.messageId))
        task.history.push(message);
      return task;
    } catch (error) {
      if (!rejected(error) || signal?.aborted || Date.now() >= deadline) throw error;
      await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
    }
  }
}
