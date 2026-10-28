import { clone, create, toBinary } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  ListTasksResponseSchema,
  MessageSchema,
  Role,
  TaskSchema,
  TaskState,
} from "../gen/a2a_pb.js";
import { object } from "../server/read-model/decode/messages.js";
import { syntheticOperations } from "./fake-kagent/scenario.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { bindTasks, environment, operator } from "./harness.js";

const reader = { subject: operator.subject, administrator: false };
const page = { query: "", pageToken: "", pageSize: 100 };

describe("task projection", () => {
  it("backfills history once, then fetches only tasks whose status moved since each watermark", async () => {
    const env = await environment();
    try {
      await env.reconcile.refresh();
      expect(env.projection.healthy()).toBe(true);
      expect(env.fake.listed.every((call) => !call.incremental)).toBe(true);
      for (const id of env.fake.tasks.keys()) expect(await env.projection.entry(id)).toBeDefined();
      // service-health left the agent list; its session still reveals the tenant.
      expect((await env.projection.entry(ids.retiredMember))?.agentId).toBe(
        "agentos/service-health",
      );
      env.fake.listed.length = 0;
      env.fake.fetched.length = 0;
      env.fake.update(env.fake.task(ids.inspection), TaskState.FAILED);
      await env.reconcile.refresh();
      expect(env.fake.listed.length).toBeGreaterThan(0);
      expect(env.fake.listed.every((call) => call.incremental)).toBe(true);
      expect(env.fake.fetched).toEqual([ids.inspection]);
      expect((await env.projection.entry(ids.inspection))?.state).toBe(TaskState.FAILED);
    } finally {
      await env.close();
    }
  });

  it("loads large historical tasks without aggregating their payloads into one RPC response", {
    timeout: 30_000,
  }, async () => {
    const env = await environment();
    const seeded = syntheticOperations(2);
    for (const task of seeded.tasks)
      task.history = [
        create(MessageSchema, {
          messageId: `input-${task.id}`,
          role: Role.USER,
          parts: [{ content: { case: "text", value: "x".repeat(9 * 1024 * 1024) } }],
        }),
      ];
    env.fake.load({
      sessions: [...env.fake.sessions.values(), ...seeded.sessions],
      tasks: seeded.tasks,
    });
    await bindTasks(env.store, env.fake, seeded.tasks);
    const list = env.clients.a2a.listTasks.bind(env.clients.a2a);
    vi.spyOn(env.clients.a2a, "listTasks").mockImplementation(async (request, options) => {
      const result = await list(request, options);
      if (toBinary(ListTasksResponseSchema, result).byteLength > 16 * 1024 * 1024)
        throw new ConnectError("response exceeds RPC limit", Code.ResourceExhausted);
      return result;
    });
    try {
      await env.reconcile.refresh();
      for (const task of seeded.tasks) {
        const entry = await env.projection.entry(task.id);
        expect(entry?.messageIds).toContain(`input-${task.id}`);
        expect(entry && (await env.projection.fullTask(entry))?.history).toEqual(task.history);
      }
    } finally {
      await env.close();
    }
  });

  it("projects saved role names and descriptions from the template", async () => {
    const env = await environment();
    try {
      await env.reconcile.refresh();
      const resource = env.fake.template("inspection").resource;
      if (!resource?.value) throw new Error("missing template");
      resource.value.metadata = {
        ...object(resource.value.metadata),
        annotations: { "agentos.dev/display-name": "Updated engineer" },
      };
      resource.value.spec = { ...object(resource.value.spec), description: "Updated duties" };
      await env.reconcile.refresh();
      expect(
        (await env.projection.agents()).find((agent) => agent.role === "inspection"),
      ).toMatchObject({ displayName: "Updated engineer", description: "Updated duties" });
    } finally {
      await env.close();
    }
  });

  it("coalesces refreshes and backfills more than 2000 sessions", async () => {
    const env = await environment();
    for (let at = 0; at < 2_100; at++)
      env.fake.createSession(
        { namespace: "agentos", name: "inspection" },
        `history-${at}`,
        `History ${at}`,
      );
    try {
      const first = env.reconcile.refresh();
      expect(env.reconcile.refresh()).toBe(first);
      await first;
      const [row] = await env.projection.store.sql`select count(*)::int as count
        from agentos_read.sessions where workspace = ${env.projection.workspace}`;
      expect(row?.count).toBe(env.fake.sessions.size);
    } finally {
      await env.close();
    }
  });

  it("overlaps watermarks so a state change at an equal timestamp is observed", async () => {
    const env = await environment();
    const seeded = syntheticOperations(2);
    const stamp = timestampFromMs(Date.now());
    for (const task of seeded.tasks) if (task.status) task.status.timestamp = stamp;
    env.fake.load({
      sessions: [...env.fake.sessions.values(), ...seeded.sessions],
      tasks: [...env.fake.tasks.values(), ...seeded.tasks],
    });
    await bindTasks(env.store, env.fake, seeded.tasks);
    try {
      await env.reconcile.refresh();
      env.fake.update(seeded.tasks[0], TaskState.FAILED);
      if (seeded.tasks[0].status) seeded.tasks[0].status.timestamp = stamp;
      await env.reconcile.refresh();
      expect((await env.projection.entry(seeded.tasks[0].id))?.state).toBe(TaskState.FAILED);
    } finally {
      await env.close();
    }
  });

  it("removes a task deleted between incremental listing and loading its payload", async () => {
    const env = await environment();
    try {
      await env.reconcile.refresh();
      const entry = await env.projection.entry(ids.inspection);
      expect(entry).toBeDefined();
      env.fake.update(env.fake.task(ids.inspection), TaskState.FAILED);
      vi.spyOn(env.clients.a2a, "getTask").mockImplementationOnce(async () => {
        env.fake.tasks.delete(ids.inspection);
        throw new ConnectError("task deleted", Code.NotFound);
      });
      await env.reconcile.refresh();
      expect(env.projection.healthy()).toBe(true);
      expect(await env.projection.entry(ids.inspection)).toBeUndefined();
      for (const id of entry?.messageIds ?? [])
        expect(await env.projection.taskOfMessage(id)).toBeUndefined();
    } finally {
      await env.close();
    }
  });

  it("keeps the newer native status when an older write arrives late", async () => {
    const env = await environment();
    try {
      await env.reconcile.refresh();
      const current = env.fake.task(ids.inspection);
      const older = clone(TaskSchema, current);
      if (older.status) older.status.timestamp = timestampFromMs(0);
      older.status = { ...older.status, state: TaskState.WORKING } as typeof older.status;
      await env.projection.apply([{ task: older, agentId: "agentos/inspection" }]);
      expect((await env.projection.entry(ids.inspection))?.state).toBe(current.status?.state);
    } finally {
      await env.close();
    }
  });

  it("notifies viewers of the execution tree a committed write changed", async () => {
    const env = await environment();
    try {
      await env.reconcile.refresh();
      const root = (await env.projection.entry(ids.inspection))?.root;
      const changes: string[][] = [];
      const stop = env.projection.onChange((change) => changes.push(change.roots));
      env.fake.update(env.fake.task(ids.inspection), TaskState.FAILED);
      await env.reconcile.refresh();
      await vi.waitFor(() => expect(changes.flat()).toContain(root));
      stop();
    } finally {
      await env.close();
    }
  });

  it("lists only the owner's executions and never unbound sessions", async () => {
    const env = await environment();
    try {
      env.fake.createSession({ namespace: "agentos", name: "assistant" }, "unbound", "Unbound");
      await env.reconcile.refresh();
      const owned = await env.projection.conversations(reader, "agentos/assistant", page);
      expect(owned.totalSize).toBeGreaterThan(0);
      expect(owned.conversations.map((item) => item.title)).not.toContain("Unbound");
      const stranger = { subject: "user:stranger", administrator: false };
      expect(
        (await env.projection.conversations(stranger, "agentos/assistant", page)).totalSize,
      ).toBe(0);
      expect((await env.projection.operations(stranger, page)).totalSize).toBe(0);
      expect((await env.projection.operations(reader, page)).totalSize).toBeGreaterThan(0);
    } finally {
      await env.close();
    }
  });
});
