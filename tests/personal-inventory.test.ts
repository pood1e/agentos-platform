import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { UserIdentitySchema } from "../gen/agentos/authorization/v1/identity_pb.js";
import { ListEngineerRunsRequestSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { ListSessionsResponseSchema, SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { fixtureExecution, fixtureIds } from "./fixtures/kagent.js";
import { consoleClient, environment, operator } from "./harness.js";

const request = { query: "", pageSize: 100, pageToken: "" };
const foreignId = "11111111-1111-4111-8111-111111111111";
const foreignTaskId = "22222222-2222-4222-8222-222222222222";
const unreadableId = "33333333-3333-4333-8333-333333333333";

async function scopedEnvironment() {
  const env = await environment();
  const owned = [...env.fake.sessions.values()];
  expect(owned.every((session) => session.creator === operator.subject)).toBe(true);
  const foreign = clone(SessionSchema, owned[0]);
  foreign.id = foreign.contextId = foreignId;
  foreign.creator = "user:another-creator";
  if (foreign.authority) {
    foreign.authority.initiatorId = foreign.creator;
    foreign.authority.rootSessionId = foreignId;
  }
  const unreadable = clone(SessionSchema, foreign);
  unreadable.id = unreadable.contextId = unreadableId;
  if (unreadable.authority) unreadable.authority.rootSessionId = unreadableId;
  const outside = clone(SessionSchema, foreign);
  outside.id = outside.contextId = "44444444-4444-4444-8444-444444444444";
  if (outside.agent) outside.agent.namespace = "other-workspace";
  const task = clone(TaskSchema, env.fake.task(fixtureIds.approvalRoot));
  task.id = foreignTaskId;
  task.contextId = foreignId;
  env.fake.sessions.set(foreignId, foreign);
  env.fake.tasks.set(task.id, task);
  env.fake.executions.set(task.id, fixtureExecution(task));
  const listSessions = vi
    .spyOn(env.clients.sessions, "listSessions")
    .mockImplementation(async (input) => {
      const sessions = input.allCreators ? [...owned, foreign, unreadable, outside] : owned;
      const offset = Number(input.page?.pageToken || 0);
      return create(ListSessionsResponseSchema, {
        sessions: sessions.slice(offset, offset + 2),
        page: { nextPageToken: offset + 2 < sessions.length ? String(offset + 2) : "" },
      });
    });
  const list = env.clients.a2a.listTasks.bind(env.clients.a2a);
  const listTasks = vi.spyOn(env.clients.a2a, "listTasks").mockImplementation((input, options) => {
    if (input.contextId === unreadableId) throw new ConnectError("task not found", Code.NotFound);
    return list(input, options);
  });
  return { ...env, owned, foreign, listSessions, listTasks };
}

afterEach(() => vi.restoreAllMocks());

describe("personal native inventory", () => {
  it.each([false, true])(
    "keeps paginated owner history and team activity for administrator=%s",
    async (administrator) => {
      const env = await scopedEnvironment();
      const reader = { subject: operator.subject, administrator };
      try {
        const conversations = await env.projection.conversations(
          reader,
          "agentos/assistant",
          request,
        );
        expect(conversations.conversations.map((item) => item.contextId)).toEqual([
          fixtureIds.chatContext,
        ]);
        expect((await env.projection.operations(reader, request)).tasks.length).toBeGreaterThan(0);
        const work = await env.projection.engineerRuns(
          reader,
          create(ListEngineerRunsRequestSchema, { engineer: "agentos/inspection", pageSize: 100 }),
        );
        expect(work.runs.length).toBeGreaterThan(0);
        expect(work.runs.every((run) => run.agentId === "agentos/inspection")).toBe(true);
        expect((await env.projection.agentActivity(reader)).size).toBeGreaterThan(0);
        expect(env.listSessions.mock.calls.length).toBeGreaterThan(3);
        expect(env.listSessions.mock.calls.every(([input]) => input.allCreators === false)).toBe(
          true,
        );
        const loaded = new Set(env.listTasks.mock.calls.map(([input]) => input.contextId));
        expect(loaded).toEqual(new Set(env.owned.map((session) => session.id)));
        expect(loaded.has(foreignId)).toBe(false);
      } finally {
        await env.close();
      }
    },
  );

  it("lists other creators' tasks and skips an unreadable system session", async () => {
    const env = await scopedEnvironment();
    try {
      const result = await consoleClient(env).listTasks({ ...request, systemOnly: true });
      expect(result.tasks.map((task) => task.id)).toEqual([foreignTaskId]);
      expect(result.totalSize).toBe(1);
      expect(env.listSessions.mock.calls.every(([input]) => input.allCreators === true)).toBe(true);
      expect(new Set(env.listTasks.mock.calls.map(([input]) => input.contextId))).toEqual(
        new Set([foreignId, unreadableId]),
      );
      const ordinary = create(UserIdentitySchema, { subject: operator.subject });
      await expect(
        consoleClient(env, {}, () => ordinary).listTasks({ ...request, systemOnly: true }),
      ).rejects.toMatchObject({ code: Code.PermissionDenied });
    } finally {
      await env.close();
    }
  });

  it("uses the same authorized system scope for engineer activity and paginated work records", async () => {
    const env = await scopedEnvironment();
    const task = clone(TaskSchema, env.fake.task(foreignTaskId));
    task.id = "55555555-5555-4555-8555-555555555555";
    if (task.status) task.status.state = TaskState.WORKING;
    env.fake.tasks.set(task.id, task);
    env.fake.executions.set(task.id, fixtureExecution(task));
    const engineer = `${env.foreign.agent?.namespace}/${env.foreign.agent?.name}`;
    const client = consoleClient(env);
    try {
      const response = await client.listEngineerRuns({ engineer, systemOnly: true, pageSize: 1 });
      expect(response.runs).toHaveLength(1);
      expect(response.nextPageToken).not.toBe("");
      const next = await client.listEngineerRuns({
        engineer,
        systemOnly: true,
        pageSize: 1,
        pageToken: response.nextPageToken,
      });
      expect(new Set([...response.runs, ...next.runs].map((run) => run.taskId))).toEqual(
        new Set([foreignTaskId, task.id]),
      );
      expect(next.nextPageToken).toBe("");
      const working = await client.listEngineerRuns({
        engineer,
        systemOnly: true,
        states: [ActivityState.WORKING],
      });
      expect(working.runs.map((run) => run.taskId)).toEqual([task.id]);
      const team = await client.listEngineers({ systemOnly: true });
      expect(team.engineers.find((member) => member.id === engineer)).toMatchObject({
        state: ActivityState.WORKING,
        activeTasks: 1,
      });
      await expect(
        client.listEngineerRuns({ engineer, pageToken: response.nextPageToken }),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
      expect(
        env.listTasks.mock.calls.some(
          ([input]) => input.contextId === "44444444-4444-4444-8444-444444444444",
        ),
      ).toBe(false);
      const ordinary = consoleClient(env, {}, () =>
        create(UserIdentitySchema, { subject: operator.subject }),
      );
      for (const read of [
        () => ordinary.listEngineerRuns({ engineer, systemOnly: true }),
        () => ordinary.listEngineers({ systemOnly: true }),
      ])
        await expect(read()).rejects.toMatchObject({ code: Code.PermissionDenied });
    } finally {
      await env.close();
    }
  });

  it("propagates system inventory failures other than a missing session", async () => {
    const env = await scopedEnvironment();
    env.listTasks.mockRejectedValue(new ConnectError("native history failed", Code.Unavailable));
    try {
      await expect(
        consoleClient(env).listTasks({ ...request, systemOnly: true }),
      ).rejects.toMatchObject({ code: Code.Unavailable });
    } finally {
      await env.close();
    }
  });

  it.each([Code.NotFound, Code.PermissionDenied, Code.Unavailable])(
    "preserves real owned-history failure code %s",
    async (code) => {
      const env = await scopedEnvironment();
      env.listTasks.mockRejectedValue(new ConnectError("native history failed", code));
      try {
        await expect(
          env.projection.conversations(
            { subject: operator.subject, administrator: true },
            "agentos/assistant",
            request,
          ),
        ).rejects.toMatchObject({ code, rawMessage: "native history failed" });
      } finally {
        await env.close();
      }
    },
  );
});
