import { clone, create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { PartSchema, Role, TaskSchema, TaskState, TaskStatusSchema } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import {
  ListSessionActivityResponseSchema,
  TaskActivitySchema,
  TaskCatalogScopeSchema,
} from "../gen/kagent/api/v1/task_catalog_pb.js";
import { catalogState } from "../server/read-model/catalog-state.js";
import { agentSummary } from "../server/read-model/views/agents.js";
import { catalogFixture, conversationProgress } from "./fake-kagent/task-catalog-model.js";
import { fixtureExecution, fixtureIds } from "./fixtures/kagent.js";
import { consoleClient, environment } from "./harness.js";

const agent = { namespace: "agentos", name: "assistant" };
afterEach(() => vi.restoreAllMocks());

it("maps recorded conversations and AgentSummary metrics without scanning session metadata", async () => {
  const env = await environment(),
    client = consoleClient(env);
  const catalog = catalogFixture(
    env.fake,
    create(TaskCatalogScopeSchema, {
      namespace: "agentos",
      visibility: { case: "owned", value: {} },
    }),
    null,
  );
  const expected = catalog.graph.agents().map((member) =>
    agentSummary(
      catalog.graph,
      member.id,
      catalog.graph.all().filter((entry) => entry.agentId === member.id),
    ),
  );
  const actual = await client.listAgents({});
  expect(actual.agents).toEqual(expected);
  expect(actual.agents.reduce((total, member) => total + member.toolCalls, 0)).toBeGreaterThan(0);
  const conversations = await client.listConversations({ agent, pageSize: 100 });
  expect(conversations.conversations[0]?.state).toBe(
    conversationProgress(catalog.graph, fixtureIds.chatContext).state,
  );
  expect(env.fake.listed).toEqual([]);
  expect(env.fake.fetched).toEqual([]);
  expect(env.fake.catalogReads.map((read) => read.method)).toEqual([
    "ListAgentActivity",
    "ListSessionActivity",
  ]);
});

it("preserves literal prompt substring search and conversation display names", async () => {
  const env = await environment(),
    client = consoleClient(env);
  const task = env.fake.task(fixtureIds.chat),
    session = env.fake.sessions.get(task.contextId);
  if (!session) throw new Error("Missing session");
  session.name = "Native conversation";
  const input = task.history.find((message) => message.role === Role.USER);
  if (!input) throw new Error("Missing input");
  input.parts = [
    create(PartSchema, { content: { case: "text", value: "A mixed %_ literal query" } }),
  ];
  const found = await client.listConversations({ agent, query: "%_ LITERAL", pageSize: 1 });
  expect(found.conversations.map((item) => item.contextId)).toEqual([session.id]);
  expect(found.conversations[0]?.title).toBe(session.name);
  expect((await client.listConversations({ agent, query: "not-present" })).conversations).toEqual(
    [],
  );
  expect(env.fake.fetched).toEqual([]);
});

it("delegates complete cursor pagination and rejects changed query scopes", async () => {
  const env = await environment(),
    client = consoleClient(env);
  for (let index = 0; index < 4; index++)
    env.fake.createSession(agent, `page-${index}`, `Additional ${index}`);
  const first = await client.listConversations({ agent, pageSize: 2 });
  const second = await client.listConversations({
    agent,
    pageSize: 2,
    pageToken: first.nextPageToken,
  });
  const third = await client.listConversations({
    agent,
    pageSize: 2,
    pageToken: second.nextPageToken,
  });
  expect(first.totalSize).toBe(5);
  expect(
    new Set(
      [...first.conversations, ...second.conversations, ...third.conversations].map(
        (item) => item.contextId,
      ),
    ).size,
  ).toBe(5);
  expect(third.nextPageToken).toBe("");
  await expect(
    client.listConversations({ agent, query: "different", pageToken: first.nextPageToken }),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
});

it("distinguishes explicitly unobserved activity from an empty idle session", async () => {
  const env = await environment(),
    client = consoleClient(env);
  const session = env.fake.sessions.get(fixtureIds.chatContext);
  if (!session) throw new Error("Missing session");
  vi.spyOn(env.clients.catalog, "listSessionActivity").mockResolvedValueOnce(
    create(ListSessionActivityResponseSchema, {
      sessions: [
        { session, activity: {} },
        { session: { ...session, id: "unobserved" }, activity: { state: TaskState.UNSPECIFIED } },
      ],
      totalSize: 2,
    }),
  );
  expect(
    (await client.listConversations({ agent })).conversations.map((item) => item.state),
  ).toEqual([ActivityState.IDLE, ActivityState.UNOBSERVED]);
  expect(
    catalogState(
      create(TaskActivitySchema, { state: TaskState.INPUT_REQUIRED, pendingToolApproval: true }),
    ),
  ).toBe(ActivityState.AWAITING_APPROVAL);
});

it.each([TaskState.WORKING, TaskState.AUTH_REQUIRED])(
  "retains a completed conversation's active child state=%s",
  async (state) => {
    const env = await environment(),
      client = consoleClient(env);
    env.fake.update(env.fake.task(fixtureIds.chatRoot), state);
    const response = await client.listConversations({ agent });
    expect(response.conversations[0]?.state).toBe(
      state === TaskState.WORKING ? ActivityState.WORKING : ActivityState.AWAITING_INPUT,
    );
    expect(env.fake.fetched).toEqual([]);
  },
);

it("fails closed on catalog errors and retries fresh without an old-API fallback", async () => {
  const env = await environment(),
    client = consoleClient(env);
  vi.spyOn(env.clients.catalog, "listAgentActivity").mockRejectedValueOnce(
    new ConnectError("unavailable", Code.Unavailable),
  );
  await expect(client.listAgents({})).rejects.toMatchObject({ code: Code.Unavailable });
  expect((await client.listAgents({})).agents.length).toBeGreaterThan(0);
  expect(env.fake.listed).toEqual([]);
  expect(env.fake.fetched).toEqual([]);
});

it.each([0, 120])(
  "keeps four listing RPC counts bounded with %s historical sessions",
  async (count) => {
    const env = await environment(),
      client = consoleClient(env);
    const source = env.fake.task(fixtureIds.inspection);
    for (let index = 0; index < count; index++) {
      const session = env.fake.createSession(
        { namespace: "agentos", name: "inspection" },
        `history-${index}`,
        "History",
      );
      const task = clone(TaskSchema, source);
      task.id = `history-${index}`;
      task.contextId = session.id;
      task.status = create(TaskStatusSchema, {
        ...task.status,
        state: TaskState.COMPLETED,
        timestamp: timestampFromMs(Date.UTC(2025, 0, 1) + index),
      });
      env.fake.tasks.set(task.id, task);
      env.fake.executions.set(task.id, fixtureExecution(task));
    }
    const lists = vi.spyOn(env.clients.sessions, "listSessions"),
      full = vi.spyOn(env.clients.a2a, "getTask"),
      agents = vi.spyOn(env.clients.agents, "listAgents"),
      templates = vi.spyOn(env.clients.templates, "listAgentTemplates");
    const lineage = vi.spyOn(env.clients.execution, "getTaskExecution");
    await client.listConversations({ agent, pageSize: 3 });
    await client.listTasks({ pageSize: 3, includeExecutionGraph: true });
    await client.listAgents({});
    await client.listAgentRuns({
      agent: { namespace: "agentos", name: "inspection" },
      pageSize: 3,
    });
    expect(env.fake.catalogReads).toHaveLength(4);
    expect(agents).toHaveBeenCalledTimes(3);
    expect(templates).toHaveBeenCalledTimes(3);
    expect(lists).not.toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
    expect(lineage).not.toHaveBeenCalled();
    expect(
      env.fake.catalogReads.find((read) => read.method === "ListTaskRecords")?.returned,
    ).toBeLessThanOrEqual(3);
  },
);

it("keeps overlapping operation roots across a system shell and includes all foreground descendants", async () => {
  const env = await environment(),
    parent = env.fake.task(fixtureIds.dispatchRoot);
  const shellSession = await env.fake.createChildSession(parent.contextId, agent, "Middle shell");
  const shell = clone(TaskSchema, parent);
  shell.id = "middle-shell";
  shell.contextId = shellSession.id;
  env.fake.update(shell, TaskState.COMPLETED);
  const leafSession = await env.fake.createChildSession(
    shellSession.id,
    { namespace: "agentos", name: "inspection" },
    "Leaf",
  );
  const leaf = clone(TaskSchema, env.fake.task(fixtureIds.inspection));
  leaf.id = "overlap-leaf";
  leaf.contextId = leafSession.id;
  env.fake.update(leaf, TaskState.WORKING);
  const response = await consoleClient(env).listTasks({
    states: [ActivityState.WORKING],
    includeExecutionGraph: true,
    pageSize: 100,
  });
  expect(response.tasks.map((task) => task.id)).toEqual(
    expect.arrayContaining([parent.id, leaf.id]),
  );
  expect(response.tasks.find((task) => task.id === parent.id)?.state).toBe(ActivityState.WORKING);
  expect(response.executionGraph?.runs.filter((run) => run.taskId === leaf.id)).toHaveLength(1);
  expect(
    response.executionGraph?.runs.find((run) => run.taskId === leaf.id)?.execution?.parent?.taskId,
  ).toBe(shell.id);
});
