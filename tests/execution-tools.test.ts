import { randomUUID } from "node:crypto";
import { create, fromJson, type JsonObject } from "@bufbuild/protobuf";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished, vi } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { ExecutionSourceSchema } from "../gen/agentos/authorization/v1/workload_pb.js";
import { GetExecutionResponseSchema } from "../gen/agentos/execution/v1/service_pb.js";
import { InvokeSessionOutputSchema } from "../gen/agentos/kagent/v1/wire_pb.js";
import { executionPrincipal } from "../server/authorization/workload-principal.js";
import { executionTools } from "../server/execution/tools.js";
import { environment } from "./harness.js";

async function setup() {
  const env = await environment([]);
  onTestFinished(() => env.close());
  const agent = { namespace: "agentos", name: "inspection" };
  const source = create(ExecutionSourceSchema, {
    issuer: "https://identity.test",
    audience: "executions",
    clientId: "analysis-controller",
    subject: "machine",
    agents: [agent],
  });
  async function connect(subject = "machine") {
    const principal = executionPrincipal({ ...source, subject });
    const handler = executionTools(
      env.clients,
      env.projection,
      "agentos",
      env.executions,
      principal,
      source.agents,
    );
    const client = new Client({ name: "external-execution-test", version: "1" });
    onTestFinished(async () => {
      await client.close();
      await handler.close();
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    return { client, principal };
  }
  return { ...env, agent, source, connect, ...(await connect()) };
}

it("uses the official MCP transport for idempotent native executions and caller-scoped queries", async () => {
  const f = await setup();
  expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "run_execution",
    "get_execution",
    "cancel_execution",
  ]);
  const execution = { requestId: randomUUID(), agent: f.agent };
  const args = { execution, message: "Inspect this incident." };
  const first = await f.client.callTool({ name: "run_execution", arguments: args });
  expect(first.isError).not.toBe(true);
  const accepted = fromJson(InvokeSessionOutputSchema, first.structuredContent as JsonObject);
  const retry = await f.client.callTool({ name: "run_execution", arguments: args });
  expect(fromJson(InvokeSessionOutputSchema, retry.structuredContent as JsonObject).taskId).toBe(
    accepted.taskId,
  );
  const native = f.fake.sessions.get(accepted.sessionId);
  if (!native) throw new Error("Missing native session");
  expect((await f.executions.resolve(native)).binding.subject).toBe(f.principal.subject);
  const read = await f.client.callTool({ name: "get_execution", arguments: { execution } });
  expect(read.isError).not.toBe(true);
  const result = fromJson(GetExecutionResponseSchema, read.structuredContent as JsonObject);
  expect(result.execution?.taskId).toBe(accepted.taskId);
  expect(result.runs.map((run) => run.taskId)).toEqual([accepted.taskId]);
  const other = await f.connect("another-machine");
  const sessions = f.fake.sessions.size;
  for (const client of [other.client, f.client]) {
    const ref = client === other.client ? execution : { ...execution, requestId: randomUUID() };
    expect(
      await client.callTool({ name: "get_execution", arguments: { execution: ref } }),
    ).toMatchObject({ isError: true });
  }
  expect(f.fake.sessions.size).toBe(sessions);
  const otherCancel = await other.client.callTool({
    name: "cancel_execution",
    arguments: execution,
  });
  expect(otherCancel.isError).not.toBe(true);
  expect(
    fromJson(InvokeSessionOutputSchema, otherCancel.structuredContent as JsonObject).sessionId,
  ).not.toBe(accepted.sessionId);
  expect((await f.executions.record(native)).binding.revoked).toBe(false);
});

it("rejects invalid or unauthorized destinations before dispatch and keeps cancellation revoked on retry", async () => {
  const f = await setup();
  const send = vi.spyOn(f.projection, "send");
  const execution = { requestId: randomUUID(), agent: f.agent };
  const args = { execution, message: "Inspect this incident." };
  for (const invalid of [
    { ...args, execution: { ...execution, requestId: "invalid" } },
    { ...args, execution: { ...execution, agent: { ...f.agent, namespace: "foreign" } } },
    { ...args, execution: { ...execution, agent: { ...f.agent, name: "remediation" } } },
    { ...args, contextId: "foreign-session" },
  ])
    expect(await f.client.callTool({ name: "run_execution", arguments: invalid })).toMatchObject({
      isError: true,
    });
  expect(send).not.toHaveBeenCalled();
  const first = await f.client.callTool({ name: "run_execution", arguments: args });
  const accepted = fromJson(InvokeSessionOutputSchema, first.structuredContent as JsonObject);
  for (let retry = 0; retry < 2; retry++)
    expect(
      await f.client.callTool({ name: "cancel_execution", arguments: execution }),
    ).not.toHaveProperty("isError", true);
  expect(f.fake.tasks.get(accepted.taskId)?.status?.state).toBe(TaskState.CANCELED);
  const calls = send.mock.calls.length;
  expect(await f.client.callTool({ name: "run_execution", arguments: args })).toMatchObject({
    isError: true,
  });
  expect(send).toHaveBeenCalledTimes(calls);
});

it("cancels an unaccepted request durably before a delayed delivery can start native work", async () => {
  const f = await setup();
  const execution = { requestId: randomUUID(), agent: f.agent };
  expect(
    (await f.client.callTool({ name: "cancel_execution", arguments: execution })).isError,
  ).not.toBe(true);
  const received = f.fake.received.length;
  expect(
    await f.client.callTool({
      name: "run_execution",
      arguments: {
        execution,
        message: "Inspect this incident.",
      },
    }),
  ).toMatchObject({ isError: true });
  expect(f.fake.received).toHaveLength(received);
});
