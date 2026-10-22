import { setTimeout as delay } from "node:timers/promises";
import { type CallOptions, Code, ConnectError } from "@connectrpc/connect";
import type { StreamResponse } from "../../gen/a2a_pb.js";
import { ErrorInfoSchema } from "../../gen/google/rpc/error_details_pb.js";
import type { KagentClients } from "./clients.js";

/** Retry only native proof that no input was accepted, before the first event. */
export async function* sendMessageStream(
  client: Pick<KagentClients["a2a"], "sendStreamingMessage">,
  request: Parameters<KagentClients["a2a"]["sendStreamingMessage"]>[0],
  options: CallOptions,
): AsyncGenerator<StreamResponse> {
  const deadline = Date.now() + 30_000;
  let received = false;
  for (;;) {
    try {
      for await (const event of client.sendStreamingMessage(request, options)) {
        received = true;
        yield event;
      }
      return;
    } catch (error) {
      const rejected =
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
      if (received || !rejected || options.signal?.aborted || Date.now() >= deadline) throw error;
      await delay(Math.min(100, deadline - Date.now()), undefined, { signal: options.signal });
    }
  }
}
