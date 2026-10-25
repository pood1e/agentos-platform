import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorInfoSchema } from "../gen/google/rpc/error_details_pb.js";

/** Server errors carry localization keys; anything else falls back to a generic key. */
export function errorKey(error: unknown, fallback: string): string {
  if (!(error instanceof ConnectError)) return fallback;
  return (
    error.findDetails(ErrorInfoSchema).find((detail) => detail.domain === "agentos.console")
      ?.reason || fallback
  );
}

/** Errors that mean the workbench or kagent cannot be reached, as opposed to rejected requests. */
export function unreachable(error: unknown): boolean {
  if (!(error instanceof ConnectError)) return true;
  return [Code.Unavailable, Code.Unknown, Code.DeadlineExceeded].includes(error.code);
}
