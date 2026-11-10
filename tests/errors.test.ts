import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { ErrorInfoSchema } from "../gen/google/rpc/error_details_pb.js";
import { errorKey, unreachable } from "../src/lib/errors.js";

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

it("explains a denied request instead of suggesting a retry", () => {
  const localized = new ConnectError("chat.executionDenied", Code.PermissionDenied, undefined, [
    { desc: ErrorInfoSchema, value: { reason: "chat.executionDenied", domain: "agentos.console" } },
  ]);
  expect(
    errorKey(new ConnectError("Native denied", Code.PermissionDenied), "chat.sendFailed"),
  ).toBe("access.denied");
  expect(errorKey(localized, "chat.sendFailed")).toBe("chat.executionDenied");
  expect(errorKey(new ConnectError("failed", Code.Internal), "chat.sendFailed")).toBe(
    "chat.sendFailed",
  );
});
