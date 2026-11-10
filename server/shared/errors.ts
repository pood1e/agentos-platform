import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorInfoSchema } from "../../gen/google/rpc/error_details_pb.js";

/** Error whose message is the localization key shown by the workbench. */
export const fail = (code: Code, key: string, cause?: unknown) =>
  new ConnectError(
    key,
    code,
    undefined,
    [{ desc: ErrorInfoSchema, value: { reason: key, domain: "agentos.console" } }],
    cause,
  );

export const unavailable = () => fail(Code.Unavailable, "connection.failed");
export const notFound = (key: string) => fail(Code.NotFound, key);
export const invalid = (key: string) => fail(Code.InvalidArgument, key);
export const conflict = (key: string) => fail(Code.Aborted, key);
export const precondition = (key: string) => fail(Code.FailedPrecondition, key);

export const hasCode = (error: unknown, ...codes: Code[]) =>
  error instanceof ConnectError && codes.includes(error.code);

/** The native resource, or undefined when it no longer exists. */
export async function unlessMissing<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    if (hasCode(error, Code.NotFound)) return undefined;
    throw error;
  }
}
