import { clone, create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactSchema, TaskSchema, TaskState, TaskStatusSchema } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { systemRoles } from "../server/read-model/agents.js";
import { createdAtKey, timelineKey } from "../server/read-model/decode/messages.js";
import { ingest } from "../server/read-model/entry.js";
import { listings } from "../server/read-model/listings.js";
import { engineer } from "../server/read-model/views/engineers.js";
import { fixtureExecution, fixtureIds } from "./fixtures/kagent.js";
import { consoleClient, environment, operator } from "./harness.js";

const reader = { subject: operator.subject, administrator: true };
const request = { query: "", pageToken: "", pageSize: 100 };
const agent = { namespace: "agentos", name: "assistant" };
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "keeps recorded conversation results equivalent with canonical creation times=%s",
  async (canonical) => {
    const env = await environment();
    try {
      for (const task of env.fake.tasks.values()) {
        const entry = ingest(task, "");
        task.metadata ??= {};
        if (canonical)
          task.metadata[createdAtKey] = new Date(
            entry.createdAt ?? entry.statusAt ?? 0,
          ).toISOString();
        else delete task.metadata[createdAtKey];
      }
      const full = await env.projection.graph([]);
      const reference = await listings(
        async () => full,
        async () => full.sessions(),
      ).conversations(reader, "agentos/assistant", request);
      env.fake.fetched.length = 0;
      const actual = await consoleClient(env).listConversations({ ...request, agent });
      expect(actual.conversations).toEqual(reference.conversations);
      expect(actual.totalSize).toBe(reference.totalSize);
      expect(actual.nextPageToken).toBe(reference.nextPageToken);
      expect(env.fake.fetched).toHaveLength(canonical ? 0 : 3);
      const cold = env.fake.fetched.length;
      await consoleClient(env).listConversations({ ...request, agent });
      expect(env.fake.fetched).toHaveLength(cold);
    } finally {
      await env.close();
    }
  },
);

it("retains native prompt search outside the conversation display name", async () => {
  const env = await environment();
  try {
    const source = env.fake.task(fixtureIds.chat);
    const session = env.fake.sessions.get(source.contextId);
    if (!session) throw new Error("Missing recorded conversation");
    session.name = "Conversation display name";
    const result = await consoleClient(env).listConversations({
      agent,
      query: "服务健康",
      pageSize: 1,
    });
    expect(result.conversations.map((item) => item.contextId)).toEqual([source.contextId]);
    expect(result.conversations[0]?.title).toBe(session.name);
    expect(env.fake.fetched.length).toBe(env.fake.tasks.size);
  } finally {
    await env.close();
  }
});

it("keeps the recorded conversation ordering and count across cursor pages", async () => {
  const env = await environment();
  try {
    for (let index = 0; index < 3; index++)
      env.fake.createSession(agent, `page-${index}`, `Additional conversation ${index}`);
    const full = await env.projection.graph([]);
    const expected = await listings(
      async () => full,
      async () => full.sessions(),
    ).conversations(reader, "agentos/assistant", request);
    const client = consoleClient(env);
    const first = await client.listConversations({ agent, pageSize: 2 });
    const second = await client.listConversations({
      agent,
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    expect([...first.conversations, ...second.conversations]).toEqual(expected.conversations);
    expect(first.totalSize).toBe(4);
    expect(second.totalSize).toBe(4);
    expect(first.nextPageToken).not.toBe("");
    expect(second.nextPageToken).toBe("");
  } finally {
    await env.close();
  }
});

it("retries a failed ordered snapshot without caching its failed task projection", async () => {
  const env = await environment();
  for (const task of env.fake.tasks.values()) if (task.metadata) delete task.metadata[createdAtKey];
  const original = env.clients.a2a.getTask.bind(env.clients.a2a);
  let failed = "";
  const get = vi
    .spyOn(env.clients.a2a, "getTask")
    .mockImplementationOnce(async (input) => {
      failed = input.id ?? "";
      throw new ConnectError("Native temporarily unavailable", Code.Unavailable);
    })
    .mockImplementation(original);
  try {
    const client = consoleClient(env);
    await expect(client.listConversations({ agent })).rejects.toMatchObject({
      code: Code.Unavailable,
    });
    expect((await client.listConversations({ agent })).conversations.length).toBeGreaterThan(0);
    expect(get.mock.calls.filter(([input]) => input.id === failed)).toHaveLength(2);
  } finally {
    await env.close();
  }
});

it("keeps creation order when an older turn changes status after a newer completed turn", async () => {
  const env = await environment();
  const source = clone(TaskSchema, env.fake.task(fixtureIds.chat));
  env.fake.tasks.clear();
  env.fake.executions.clear();
  for (const [index, state] of [TaskState.FAILED, TaskState.COMPLETED].entries()) {
    const task = clone(TaskSchema, source);
    task.id = `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    task.metadata = {};
    task.history = [];
    task.status = create(TaskStatusSchema, {
      state,
      timestamp: timestampFromMs(Date.UTC(2027, 0, 4 - index)),
    });
    task.artifacts = [
      create(ArtifactSchema, {
        artifactId: `result-${index}`,
        metadata: { [timelineKey]: new Date(Date.UTC(2027, 0, index + 1)).toISOString() },
        parts: [{ content: { case: "text", value: "Turn result" } }],
      }),
    ];
    env.fake.tasks.set(task.id, task);
    env.fake.executions.set(task.id, fixtureExecution(task));
  }
  try {
    const client = consoleClient(env);
    const result = await client.listConversations({ agent });
    expect(result.conversations[0]).toMatchObject({
      contextId: source.contextId,
      state: ActivityState.SUCCEEDED,
    });
    expect(env.fake.fetched).toHaveLength(2);
    await client.listConversations({ agent });
    expect(env.fake.fetched).toHaveLength(2);
  } finally {
    await env.close();
  }
});

it("reads Agent metadata once and preserves recorded Engineer tool-call statistics", async () => {
  const env = await environment();
  try {
    const full = await env.projection.graph([]);
    const expected = full
      .agents()
      .filter((member) => !member.workflow && !systemRoles.has(member.role))
      .map((member) => engineer(full, member.id, full.agentEntries(member.id)));
    const agents = vi.spyOn(env.clients.agents, "listAgents");
    const templates = vi.spyOn(env.clients.templates, "listAgentTemplates");
    const response = await consoleClient(env).listEngineers({});
    expect(response.engineers).toEqual(expected);
    expect(
      response.engineers.reduce((count, member) => count + member.toolCalls, 0),
    ).toBeGreaterThan(0);
    expect(agents).toHaveBeenCalledOnce();
    expect(templates).toHaveBeenCalledOnce();
  } finally {
    await env.close();
  }
});

it("loads Agent metadata while task hydration is still pending", async () => {
  const env = await environment();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get = env.clients.a2a.getTask.bind(env.clients.a2a);
  const hydration = vi
    .spyOn(env.clients.a2a, "getTask")
    .mockImplementation(async (input, options) => {
      await gate;
      return get(input, options);
    });
  const agents = vi.spyOn(env.clients.agents, "listAgents");
  const templates = vi.spyOn(env.clients.templates, "listAgentTemplates");
  try {
    const result = consoleClient(env).listEngineers({});
    await vi.waitFor(() => expect(hydration).toHaveBeenCalled());
    expect(agents).toHaveBeenCalledOnce();
    expect(templates).toHaveBeenCalledOnce();
    release();
    await result;
  } finally {
    release();
    await env.close();
  }
});

it.each([TaskState.WORKING, TaskState.AUTH_REQUIRED])(
  "keeps a completed conversation active through native child state %s",
  async (state) => {
    const env = await environment();
    try {
      const child = env.fake.task(fixtureIds.chatRoot);
      env.fake.update(child, state);
      const result = await consoleClient(env).listConversations({ agent });
      expect(result.conversations[0]?.state).toBe(
        state === TaskState.WORKING ? ActivityState.WORKING : ActivityState.AWAITING_INPUT,
      );
      expect(env.fake.fetched).toContain(child.id);
      const current = await consoleClient(env).listTasks({
        includeExecutionGraph: true,
        states: [ActivityState.WORKING, ActivityState.AWAITING_INPUT],
      });
      expect(current.tasks.find((task) => task.id === child.id)?.state).toBe(
        result.conversations[0]?.state,
      );
    } finally {
      await env.close();
    }
  },
);
