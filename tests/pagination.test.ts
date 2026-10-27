import { clone } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { TaskSchema } from "../gen/a2a_pb.js";
import { syntheticOperations } from "./fake-kagent/scenario.js";
import { bindTasks, environment, operator } from "./harness.js";

const reader = { subject: operator.subject, administrator: false };

async function seededEnvironment() {
  const env = await environment();
  const seeded = syntheticOperations(30);
  env.fake.load({
    sessions: [...env.fake.sessions.values(), ...seeded.sessions],
    tasks: [...env.fake.tasks.values(), ...seeded.tasks],
  });
  await bindTasks(env.store, env.fake, seeded.tasks);
  await env.reconcile.refresh();
  return { env, seeded };
}

describe("history cursors", () => {
  it("continues after an identity when newer operations arrive, and allows changing page size", async () => {
    const { env, seeded } = await seededEnvironment();
    try {
      const request = { query: "巡检第", pageSize: 12, pageToken: "" };
      const first = await env.projection.operations(reader, request);
      expect(first.tasks).toHaveLength(12);
      expect(first.totalSize).toBe(30);
      expect(first.nextPageToken).not.toBe("");
      const incoming = clone(TaskSchema, seeded.tasks[0]);
      incoming.id = "newer-operation";
      incoming.history = incoming.history.map((message) => ({
        ...message,
        messageId: `newer-${message.messageId}`,
      })) as typeof incoming.history;
      if (incoming.status) incoming.status.timestamp = timestampFromMs(Date.now() + 10_000);
      await env.projection.apply([{ task: incoming, agentId: "agentos/inspection" }]);
      const next = await env.projection.operations(reader, {
        ...request,
        pageSize: 5,
        pageToken: first.nextPageToken,
      });
      expect(next.tasks).toHaveLength(5);
      expect(
        next.tasks.every((task) => !first.tasks.some((previous) => previous.id === task.id)),
      ).toBe(true);
      expect(next.totalSize).toBe(31);
      await expect(
        env.projection.operations(reader, {
          ...request,
          query: "different",
          pageToken: first.nextPageToken,
        }),
      ).rejects.toThrow("pagination.invalidPage");
      await expect(
        env.projection.operations(reader, { ...request, pageToken: "invalid" }),
      ).rejects.toThrow("pagination.invalidPage");
    } finally {
      await env.close();
    }
  });

  it("continues from the cursor position when its operation moves to the top", async () => {
    const { env } = await seededEnvironment();
    try {
      const request = { query: "巡检第", pageSize: 12, pageToken: "" };
      const first = await env.projection.operations(reader, request);
      const second = await env.projection.operations(reader, {
        ...request,
        pageToken: first.nextPageToken,
      });
      const last = env.fake.task(first.tasks.at(-1)?.id ?? "");
      const moved = clone(TaskSchema, last);
      if (moved.status) moved.status.timestamp = timestampFromMs(Date.now() + 10_000);
      await env.projection.apply([{ task: moved, agentId: "agentos/inspection" }]);
      expect(
        (await env.projection.operations(reader, { ...request, pageToken: first.nextPageToken }))
          .tasks,
      ).toEqual(second.tasks);
    } finally {
      await env.close();
    }
  });

  it("keeps conversation kinds and search queries in separate cursor scopes", async () => {
    const env = await environment();
    env.fake.createSession({ namespace: "agentos", name: "assistant" }, "extra-chat", "另一次对话");
    await bindTasks(env.store, env.fake, []);
    try {
      await env.reconcile.refresh();
      const request = { query: "", pageSize: 1, pageToken: "" };
      const first = await env.projection.conversations(reader, "agentos/assistant", request);
      expect(first.totalSize).toBe(2);
      const second = await env.projection.conversations(reader, "agentos/assistant", {
        ...request,
        pageToken: first.nextPageToken,
      });
      expect(second.conversations[0]?.contextId).not.toBe(first.conversations[0]?.contextId);
      expect(second.nextPageToken).toBe("");
      await expect(
        env.projection.conversations(reader, "agentos/role-builder", {
          ...request,
          pageToken: first.nextPageToken,
        }),
      ).rejects.toThrow("pagination.invalidPage");
    } finally {
      await env.close();
    }
  });
});
