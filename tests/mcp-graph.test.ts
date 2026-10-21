import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { ToolCallSchema } from "../gen/agentos/execution/v1/task_pb.js";
import { mcpCalls } from "../src/features/tasks/flow/mcp-calls.js";

it("aggregates different and repeated tool calls into discovered MCP services", () => {
  const calls = [
    ["pods_list", 1, ActivityState.SUCCEEDED],
    ["pods_log", 2, ActivityState.FAILED],
    ["pods_log", 3, ActivityState.WORKING],
    ["search_assets", 4, ActivityState.SUCCEEDED],
    ["invoke_session", 5, ActivityState.SUCCEEDED],
    ["unresolved_tool", 6, ActivityState.SUCCEEDED],
  ] as const;
  const groups = mcpCalls(
    calls.map(([name, at, state]) =>
      create(ToolCallSchema, { name, state, startedAt: timestampFromMs(at) }),
    ),
    (name) =>
      name.startsWith("pods_")
        ? "production/kubernetes"
        : name === "search_assets"
          ? "production/netbox"
          : undefined,
  );
  expect(groups.map((group) => group.server)).toEqual([
    "production/kubernetes",
    "production/netbox",
  ]);
  expect(groups[0]).toMatchObject({ state: ActivityState.WORKING });
  expect(groups[0]?.calls.map((call) => call.name)).toEqual(["pods_list", "pods_log", "pods_log"]);
  expect(groups[1]?.calls).toHaveLength(1);
});

it("keeps services distinct when their discovered references differ", () => {
  const groups = mcpCalls(
    ["prod_pods_list", "test_pods_list"].map((name) => create(ToolCallSchema, { name })),
    (name) => (name.startsWith("prod") ? "prod/kubernetes" : "test/kubernetes"),
  );
  expect(new Set(groups.map((group) => group.id)).size).toBe(2);
});
