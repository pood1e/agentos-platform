import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { unreachable } from "../shared/errors.js";

it("distinguishes failed operations from an unavailable workbench", () => {
  for (const code of [
    Code.Internal,
    Code.PermissionDenied,
    Code.InvalidArgument,
    Code.Unauthenticated,
  ])
    expect(unreachable(new ConnectError("request failed", code))).toBe(false);
  for (const code of [Code.Unavailable, Code.Unknown, Code.DeadlineExceeded])
    expect(unreachable(new ConnectError("transport failed", code))).toBe(true);
});
