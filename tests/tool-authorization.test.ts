import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { RoleDefinitionSchema } from "../gen/agentos/console/v1/role_pb.js";
import { authorizeToolSelection } from "../server/authorization/tools.js";
import { ToolBindings } from "../server/governance/bindings.js";
import { parseCatalog } from "../shared/tool-catalog.js";

it("distinguishes the caller's read-only ceiling from an unselected or unknown Agent tool", () => {
  const policy = new ToolBindings(
    parseCatalog("", "service:\n  readOnly: [read]\n  write: [write, delete]\n"),
    new Map(),
  );
  const role = create(RoleDefinitionSchema, {
    tools: [{ server: "service", tools: ["service_read", "service_write", "service_unknown"] }],
  });
  const authorize = (tools: string[], write: boolean) =>
    authorizeToolSelection(policy, "engineer", role, tools, write);
  expect(() => authorize(["service_read"], false)).not.toThrow();
  expect(() => authorize(["mcp__service__service_write"], true)).not.toThrow();
  expect(() => authorize(["service_write"], false)).toThrowError(
    expect.objectContaining({
      code: Code.PermissionDenied,
      rawMessage: "This execution has read-only permissions",
    }),
  );
  for (const name of ["service_unknown", "service_delete", "other_write"]) {
    expect(() => authorize([name], true)).toThrowError(
      expect.objectContaining({
        code: Code.PermissionDenied,
        rawMessage: "This Agent is not permitted to call this tool",
      }),
    );
  }
});
