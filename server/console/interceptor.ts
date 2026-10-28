import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import { ErrorInfoSchema } from "../../gen/google/rpc/error_details_pb.js";
import { fail } from "../shared/errors.js";

const invalidKeys: Record<string, string> = {
  SendMessage: "chat.invalidMessage",
  RespondInteraction: "interaction.invalidAnswer",
  CreateRole: "configuration.invalidRole",
  UpdateRole: "configuration.invalidRole",
  ListTasks: "pagination.invalidPage",
  ListConversations: "pagination.invalidPage",
  StartVoiceSession: "speech.requestRejected",
};

/**
 * Keeps localized handler errors and gives validation failures a localization key.
 * Other failures are logged and reach the browser without internal details; the
 * browser then describes the action that failed.
 */
export function consoleErrors(log: FastifyBaseLogger): Interceptor {
  const localized = (error: unknown, method: string) => {
    const source = ConnectError.from(error);
    if (source.findDetails(ErrorInfoSchema).some((detail) => detail.domain === "agentos.console"))
      return source;
    if (source.code === Code.InvalidArgument)
      return fail(source.code, invalidKeys[method] ?? "request.invalid", source);
    if (source.code !== Code.Canceled) log.error({ err: source, method }, "console request failed");
    return new ConnectError("request failed", source.code);
  };

  async function* guarded<T>(source: AsyncIterable<T>, method: string) {
    try {
      yield* source;
    } catch (error) {
      throw localized(error, method);
    }
  }

  return (next) => async (request) => {
    try {
      const response = await next(request);
      return response.stream
        ? { ...response, message: guarded(response.message, request.method.name) }
        : response;
    } catch (error) {
      throw localized(error, request.method.name);
    }
  };
}
