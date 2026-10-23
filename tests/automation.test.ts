import { expect, it, vi } from "vitest";
import { automationTools } from "../server/platform/automation.js";
import { environment } from "./harness.js";

async function run(handler: ReturnType<typeof automationTools>, args: object) {
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "run_case", arguments: args },
      }),
    }),
  );
  const body = await response.text();
  return JSON.parse(body.startsWith("event:") ? (body.split("data: ")[1] ?? "{}") : body);
}

it("reuses one native context per source case and isolates identical case keys in different environments", async () => {
  const { clients, sync } = environment();
  const create = vi.spyOn(clients.sessions, "createSession");
  const invoke = vi.spyOn(sync, "send");
  const first = automationTools(clients, sync, "agentos", "first");
  const second = automationTools(clients, sync, "agentos", "second");
  const request = {
    case: {
      key: "alerts/incident",
      version: "1",
      agent: { namespace: "agentos", name: "inspection" },
    },
    message: "Inspect this incident.",
  };
  expect((await run(first, request)).result.isError).not.toBe(true);
  await run(first, request);
  await run(first, { ...request, case: { ...request.case, version: "2" } });
  await run(second, request);
  expect(create.mock.calls.map(([request]) => request.requestId)).toEqual([
    create.mock.calls[0]?.[0].requestId,
    create.mock.calls[0]?.[0].requestId,
    create.mock.calls[0]?.[0].requestId,
    expect.not.stringMatching(create.mock.calls[0]?.[0].requestId ?? ""),
  ]);
  expect(invoke.mock.calls[0]?.[1].contextId).toBe(invoke.mock.calls[1]?.[1].contextId);
  expect(invoke.mock.calls[0]?.[1].messageId).toBe(invoke.mock.calls[1]?.[1].messageId);
  expect(invoke.mock.calls[2]?.[1].messageId).not.toBe(invoke.mock.calls[0]?.[1].messageId);
  expect(invoke.mock.calls[3]?.[1].contextId).not.toBe(invoke.mock.calls[0]?.[1].contextId);
  expect(JSON.stringify(invoke.mock.calls[3]?.[1])).toContain("Environment: second");
  sync.close();
});

it("rejects caller-selected sessions, destinations and environments before native creation", async () => {
  const { clients, sync } = environment();
  const create = vi.spyOn(clients.sessions, "createSession");
  const invoke = vi.spyOn(sync, "send");
  const handler = automationTools(clients, sync, "agentos", "owned");
  const request = {
    case: { key: "incident", version: "1", agent: { namespace: "agentos", name: "inspection" } },
    message: "Inspect this incident.",
  };
  for (const extra of [
    { contextId: "foreign-session" },
    { environment: "foreign" },
    { agent: "remediation" },
  ]) {
    const response = await run(handler, { ...request, ...extra });
    expect(response.error || response.result?.isError).toBeTruthy();
  }
  expect(create).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  sync.close();
});
