import { expect, it, onTestFinished } from "vitest";
import { automationPresets } from "../server/automation/presets.js";
import { scheduledSourceTools } from "../server/automation/source-tools.js";
import { environment } from "./harness.js";

it("exposes only read-only result tools and refuses schedules outside the source binding", async () => {
  const env = environment([]);
  onTestFinished(() => env.sync.close());
  const presets = automationPresets("agentos", "tests/fixtures/pack");
  await presets.seed(env.clients);
  const first = presets.scheduledRuns[0];
  if (!first) throw new Error("Missing preset");
  const handler = scheduledSourceTools(env.clients, env.sync, "agentos", presets.scheduledRuns, [
    first.key,
  ]);
  async function rpc(method: string, params: object = {}) {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const body = await response.text();
    return JSON.parse(body.startsWith("event:") ? (body.split("data: ")[1] ?? "{}") : body);
  }
  const tools = (await rpc("tools/list")).result.tools;
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
    "list_scheduled_run_executions",
    "get_scheduled_run_execution_result",
  ]);
  expect(
    tools.every(
      (tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint,
    ),
  ).toBe(true);
  const denied = await rpc("tools/call", {
    name: "list_scheduled_run_executions",
    arguments: { presetKey: "foreign" },
  });
  expect(denied.error || denied.result?.isError).toBeTruthy();
  const write = await rpc("tools/call", { name: "run_case", arguments: {} });
  expect(write.error || write.result?.isError).toBeTruthy();
});
