import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";
import { MessageSchema, Role, StreamResponseSchema, TaskState } from "../gen/a2a_pb.js";
import { object } from "../server/read-model/decode/messages.js";
import { syntheticOperations } from "./fake-kagent/scenario.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment, until } from "./harness.js";

describe("kagent synchronization", () => {
  it("projects saved role names and descriptions from the template", async () => {
    const { fake, sync, index } = environment();
    try {
      await sync.refresh();
      const resource = fake.template("inspection").resource;
      if (!resource?.value) throw new Error("missing template");
      resource.value.metadata = {
        ...object(resource.value.metadata),
        annotations: { "agentos.dev/display-name": "Updated engineer" },
      };
      resource.value.spec = { ...object(resource.value.spec), description: "Updated duties" };
      await sync.refresh();
      expect(index.agents().find((agent) => agent.role === "inspection")).toMatchObject({
        displayName: "Updated engineer",
        description: "Updated duties",
      });
    } finally {
      sync.close();
    }
  });

  it("coalesces refreshes and loads more than 2000 sessions", async () => {
    const { fake, sync, index } = environment();
    for (let at = 0; at < 2_100; at++)
      fake.createSession(
        { namespace: "agentos", name: "inspection" },
        `history-${at}`,
        `History ${at}`,
      );
    try {
      const first = sync.refresh();
      expect(sync.refresh()).toBe(first);
      await first;
      expect(index.sessions()).toHaveLength(fake.sessions.size);
      expect(index.sessions().length).toBeGreaterThan(2_000);
    } finally {
      sync.close();
    }
  });

  it("overlaps watermarks so a state change at an equal timestamp is observed", async () => {
    const { fake, sync, index } = environment();
    const seeded = syntheticOperations(2);
    const stamp = timestampFromMs(Date.now());
    for (const task of seeded.tasks) if (task.status) task.status.timestamp = stamp;
    fake.load({
      sessions: [...fake.sessions.values(), ...seeded.sessions],
      tasks: [...fake.tasks.values(), ...seeded.tasks],
    });
    try {
      await sync.refresh();
      fake.update(seeded.tasks[0], TaskState.FAILED);
      if (seeded.tasks[0].status) seeded.tasks[0].status.timestamp = stamp;
      await sync.refresh();
      expect(index.entry(seeded.tasks[0].id)?.state).toBe(TaskState.FAILED);
    } finally {
      sync.close();
    }
  });

  it("backs off a broken subscription and reloads its durable task before reconnecting", async () => {
    const { fake, sync, clients } = environment();
    fake.update(fake.task(ids.inspection), TaskState.WORKING);
    const subscribe = vi
      .spyOn(clients.a2a, "subscribeToTask")
      .mockImplementationOnce(async function* () {
        yield create(StreamResponseSchema, {
          payload: { case: "task", value: fake.task(ids.inspection) },
        });
        throw new Error("interrupted");
      });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await sync.refresh();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(subscribe).toHaveBeenCalledTimes(1);
      await sync.refresh();
      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(fake.fetched).toContain(ids.inspection);
      const now = Date.now();
      clock = vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
      await sync.refresh();
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      clock?.mockRestore();
      sync.close();
    }
  });

  it("reloads a broken subscription that no incremental listing returns", async () => {
    const { fake, sync, clients } = environment();
    fake.update(fake.task(ids.inspection), TaskState.WORKING);
    const list = clients.a2a.listTasks.bind(clients.a2a);
    vi.spyOn(clients.a2a, "listTasks").mockImplementation(async (request, options) => {
      const page = await list(request, options);
      if (request.statusTimestampAfter)
        page.tasks = page.tasks.filter((task) => task.id !== ids.inspection);
      return page;
    });
    const subscribe = vi
      .spyOn(clients.a2a, "subscribeToTask")
      .mockImplementationOnce(async function* () {
        yield* [];
        throw new Error("interrupted");
      });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await sync.refresh();
      await new Promise((resolve) => setTimeout(resolve, 20));
      fake.fetched.length = 0;
      const now = Date.now();
      clock = vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
      await sync.refresh();
      expect(fake.fetched).toEqual([ids.inspection]);
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      clock?.mockRestore();
      sync.close();
    }
  });

  it("loads history once, then lists only tasks changed since each watermark", async () => {
    const { fake, sync, index } = environment();
    await sync.refresh();
    expect(sync.healthy()).toBe(true);
    expect(fake.listed.every((call) => !call.incremental)).toBe(true);
    expect(index.all()).toHaveLength(fake.tasks.size);
    // service-health left the agent list; its session still reveals the tenant.
    expect(index.entry(ids.retiredMember)?.agentId).toBe("agentos/service-health");

    fake.listed.length = 0;
    fake.update(fake.task(ids.inspection), TaskState.FAILED);
    await sync.refresh();
    expect(fake.listed.length).toBeGreaterThan(0);
    expect(fake.listed.every((call) => call.incremental)).toBe(true);
    expect(fake.fetched).toEqual([ids.inspection]);
    expect(index.entry(ids.inspection)?.state).toBe(TaskState.FAILED);
  });

  it("follows a sent message until its task completes", async () => {
    const { sync, index } = environment();
    await sync.refresh();
    const chat = index.sessions().find((session) => session.agentId === "agentos/assistant");
    const task = await sync.send(
      "agentos/assistant",
      create(MessageSchema, {
        messageId: "message-1",
        contextId: chat?.id,
        role: Role.USER,
        parts: [{ content: { case: "text", value: "检查节点" } }],
      }),
    );
    expect(index.entry(task.id)?.state).toBe(TaskState.WORKING);
    await until(() => index.entry(task.id)?.state === TaskState.COMPLETED);
    expect(index.entry(task.id)?.answer).toBe("已处理：检查节点");
    sync.close();
  });
});
