import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ingest } from "../server/read-model/entry.js";
import { TaskIndex } from "../server/read-model/index.js";
import { syntheticOperations } from "./fake-kagent/scenario.js";
import { environment } from "./harness.js";

describe("streamed task content", () => {
  it("observes a text replacement with the same status, history length and part count", () => {
    const task = create(TaskSchema, {
      id: "stream",
      contextId: "context",
      status: { state: TaskState.WORKING, timestamp: timestampFromMs(1000) },
      artifacts: [{ artifactId: "answer", parts: [{ content: { case: "text", value: "first" } }] }],
    });
    const index = new TaskIndex();
    index.upsert(ingest(task, "agentos/inspection"));
    const previous = index.entry(task.id)?.version;
    task.artifacts[0].parts[0].content = { case: "text", value: "updated" };
    expect(index.upsert(ingest(task, "agentos/inspection"))).toBe(true);
    expect(index.entry(task.id)?.answer).toBe("updated");
    expect(index.entry(task.id)?.version).not.toBe(previous);
    expect(index.upsert(ingest(task, "agentos/inspection"))).toBe(false);
  });

  it("evicts old full payloads while retaining their compact history entries", async () => {
    const { fake, index, sync } = environment();
    const seeded = syntheticOperations(220);
    fake.load({
      sessions: [...fake.sessions.values(), ...seeded.sessions],
      tasks: [...fake.tasks.values(), ...seeded.tasks],
    });
    await sync.refresh();
    try {
      expect(index.entry("synthetic-task-0")).toBeDefined();
      expect(fake.fetched).toHaveLength(0);
      expect((await sync.fullTask("synthetic-task-0"))?.id).toBe("synthetic-task-0");
      expect(fake.fetched).toContain("synthetic-task-0");
      await sync.fullTask("synthetic-task-0");
      expect(fake.fetched.filter((id) => id === "synthetic-task-0")).toHaveLength(1);
    } finally {
      sync.close();
    }
  });
});
