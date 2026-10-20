import { clone } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { TaskSchema } from "../gen/a2a_pb.js";
import { ingest } from "../server/read-model/entry.js";
import { listConversations } from "../server/read-model/views/conversation.js";
import { listTasks } from "../server/read-model/views/task.js";
import { syntheticOperations } from "./fake-kagent/scenario.js";
import { environment } from "./harness.js";

describe("history cursors", () => {
  it("continues after an identity when newer operations arrive, and allows changing page size", async () => {
    const { fake, index, sync } = environment();
    const seeded = syntheticOperations(30);
    fake.load({
      sessions: [...fake.sessions.values(), ...seeded.sessions],
      tasks: [...fake.tasks.values(), ...seeded.tasks],
    });
    await sync.refresh();
    try {
      const request = { query: "巡检第", pageSize: 12, pageToken: "" };
      const first = listTasks(index, request);
      expect(first.tasks).toHaveLength(12);
      expect(first.totalSize).toBe(30);
      expect(first.nextPageToken).not.toBe("");
      const incoming = clone(TaskSchema, seeded.tasks[0]);
      incoming.id = "newer-operation";
      if (incoming.status) incoming.status.timestamp = timestampFromMs(Date.now() + 10_000);
      index.upsert(ingest(incoming, "agentos/inspection"));
      const next = listTasks(index, { ...request, pageSize: 5, pageToken: first.nextPageToken });
      expect(next.tasks).toHaveLength(5);
      expect(
        next.tasks.every((task) => !first.tasks.some((previous) => previous.id === task.id)),
      ).toBe(true);
      expect(next.totalSize).toBe(31);
      expect(() =>
        listTasks(index, { ...request, query: "different", pageToken: first.nextPageToken }),
      ).toThrow("pagination.invalidPage");
      expect(() => listTasks(index, { ...request, pageToken: "invalid" })).toThrow(
        "pagination.invalidPage",
      );
    } finally {
      sync.close();
    }
  });

  it("continues from the cursor position when its operation moves to the top", async () => {
    const { fake, index, sync } = environment();
    const seeded = syntheticOperations(30);
    fake.load({
      sessions: [...fake.sessions.values(), ...seeded.sessions],
      tasks: [...fake.tasks.values(), ...seeded.tasks],
    });
    await sync.refresh();
    try {
      const request = { query: "巡检第", pageSize: 12, pageToken: "" };
      const first = listTasks(index, request);
      const second = listTasks(index, { ...request, pageToken: first.nextPageToken });
      const last = index.entry(first.tasks.at(-1)?.id ?? "");
      if (!last) throw new Error("missing operation");
      index.upsert({ ...last, statusAt: Date.now() + 10_000, version: "moved" });
      expect(listTasks(index, { ...request, pageToken: first.nextPageToken }).tasks).toEqual(
        second.tasks,
      );
    } finally {
      sync.close();
    }
  });

  it("keeps conversation kinds and search queries in separate cursor scopes", async () => {
    const { fake, index, sync } = environment();
    fake.createSession({ namespace: "agentos", name: "assistant" }, "extra-chat", "另一次对话");
    await sync.refresh();
    try {
      const request = { query: "", pageSize: 1, pageToken: "" };
      const first = listConversations(index, { namespace: "agentos", name: "assistant" }, request);
      expect(first.totalSize).toBe(2);
      const second = listConversations(
        index,
        { namespace: "agentos", name: "assistant" },
        {
          ...request,
          pageToken: first.nextPageToken,
        },
      );
      expect(second.conversations[0]?.contextId).not.toBe(first.conversations[0]?.contextId);
      expect(second.nextPageToken).toBe("");
      expect(() =>
        listConversations(
          index,
          { namespace: "agentos", name: "role-builder" },
          {
            ...request,
            pageToken: first.nextPageToken,
          },
        ),
      ).toThrow("pagination.invalidPage");
    } finally {
      sync.close();
    }
  });
});
