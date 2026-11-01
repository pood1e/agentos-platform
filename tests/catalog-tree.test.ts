import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { TaskSchema, TaskState } from "../gen/a2a_pb.js";
import type { WatchConversationResponse } from "../gen/agentos/console/v1/console_service_pb.js";
import { TaskExecutionSchema } from "../gen/kagent/api/v1/execution_pb.js";
import { RuntimeState } from "../gen/kagent/api/v1/runtime_pb.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { consoleClient, environment } from "./harness.js";

it("anchors a readable child tree at its live session after the root was deleted", async () => {
  const env = await environment(),
    child = env.fake.task(ids.inspection);
  const execution = env.fake.executions.get(child.id),
    session = env.fake.sessions.get(child.contextId);
  const root = execution?.root && env.fake.sessions.get(execution.root.sessionId);
  if (!session || !root || root.id === session.id) throw new Error("Missing native tree");
  root.state = RuntimeState.DELETED;
  const list = vi.spyOn(env.clients.sessions, "listSessions"),
    catalog = vi.spyOn(env.clients.catalog, "listTaskRecords");
  const graph = await env.projection.graphOf({ contextId: session.id });
  expect(graph?.entry(child.id)?.execution).toEqual(execution);
  expect(graph?.session(root.id)).toBeUndefined();
  expect(catalog.mock.calls[0]?.[0].scope?.visibility).toEqual({
    case: "sessionTreeAnchor",
    value: session.id,
  });
  expect(list).not.toHaveBeenCalled();
  const client = consoleClient(env),
    abort = new AbortController();
  const stream = client
    .watchConversation({ agent: session.agent, contextId: session.id }, { signal: abort.signal })
    [Symbol.asyncIterator]();
  const snapshot: WatchConversationResponse | undefined = (await stream.next()).value;
  expect(snapshot?.conversation?.runs.some((run) => run.taskId === child.id)).toBe(true);
  abort.abort();
  await stream.return?.();
});

it("retains the authorized empty anchor without creating synthetic runs", async () => {
  const env = await environment();
  const session = env.fake.createSession(
    { namespace: "agentos", name: "assistant" },
    "empty-anchor",
    "Empty",
  );
  const graph = await env.projection.graphOf({ contextId: session.id });
  expect(graph?.session(session.id)?.id).toBe(session.id);
  expect(graph?.all()).toEqual([]);
});

it("reads complete paginated authority trees through catalog pages and rejects repeated cursors", async () => {
  const env = await environment(),
    source = env.fake.task(ids.inspection);
  env.fake.tasks.clear();
  env.fake.executions.clear();
  for (let index = 0; index < 205; index++) {
    const task = clone(TaskSchema, source);
    task.id = `tree-${index}`;
    task.status = create(TaskSchema, { status: { state: TaskState.COMPLETED } }).status;
    env.fake.tasks.set(task.id, task);
    env.fake.executions.set(
      task.id,
      create(TaskExecutionSchema, {
        task: { taskId: task.id, sessionId: task.contextId },
        root: { taskId: task.id, sessionId: task.contextId },
      }),
    );
  }
  expect((await env.projection.graphOf({ contextId: source.contextId }))?.all()).toHaveLength(205);
  expect(env.fake.catalogReads).toHaveLength(3);
  expect(env.fake.listed).toEqual([]);
  expect(env.fake.fetched).toEqual([]);
  const original = env.clients.catalog.listTaskRecords.bind(env.clients.catalog);
  vi.spyOn(env.clients.catalog, "listTaskRecords").mockImplementation(async (request, options) => {
    const response = await original(request, options);
    response.page = { $typeName: "kagent.api.v1.PageResponse", nextPageToken: "repeated" };
    return response;
  });
  await expect(env.projection.graph(source.contextId)).rejects.toThrow();
});

it("propagates unavailable or denied catalog reads without resurrecting a stale tree", async () => {
  const env = await environment(),
    contextId = env.fake.task(ids.inspection).contextId;
  for (const code of [Code.PermissionDenied, Code.Unavailable]) {
    const spy = vi
      .spyOn(env.clients.catalog, "listTaskRecords")
      .mockRejectedValueOnce(new ConnectError("denied", code));
    await expect(env.projection.graph(contextId)).rejects.toMatchObject({ code });
    spy.mockRestore();
  }
  expect((await env.projection.graph(contextId)).all().length).toBeGreaterThan(0);
});
