import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it, vi } from "vitest";
import { TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { WatchConversationResponseSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import { watch } from "../server/console/watch.js";
import { ingest } from "../server/read-model/entry.js";
import { TaskIndex } from "../server/read-model/index.js";
import { ObservationScope } from "../server/read-model/observation.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, value: unknown, { signal }: { signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const timer = setTimeout(done, ms);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
}));

afterEach(() => vi.useRealTimers());

it("keeps unchanged observations alive without reloading the view and cancels pending timers", async () => {
  vi.useFakeTimers();
  const index = new TaskIndex();
  const sync = { index, healthy: () => true };
  const value = create(WatchConversationResponseSchema, { conversation: { title: "交换机巡检" } });
  const view = vi.fn(() => value);
  const controller = new AbortController();
  const stream = watch(sync, WatchConversationResponseSchema, controller.signal, view);
  expect((await stream.next()).value).toEqual(value);
  const heartbeat = stream.next();
  await vi.advanceTimersByTimeAsync(16_000);
  expect((await heartbeat).value).toEqual(value);
  expect(view).toHaveBeenCalledOnce();
  const pending = stream.next();
  controller.abort();
  expect((await pending).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("closes with a retryable error when the read model is unavailable", async () => {
  vi.useFakeTimers();
  let healthy = true;
  const index = new TaskIndex();
  const view = vi.fn(() => create(WatchConversationResponseSchema));
  const stream = watch(
    { index, healthy: () => healthy },
    WatchConversationResponseSchema,
    new AbortController().signal,
    view,
  );
  await stream.next();
  healthy = false;
  const failed = expect(stream.next()).rejects.toMatchObject({ code: 14 });
  await vi.advanceTimersByTimeAsync(500);
  await failed;
});

it("ignores unrelated work while observing changes in the selected conversation", async () => {
  vi.useFakeTimers();
  const index = new TaskIndex();
  index.upsert(
    ingest(
      create(TaskSchema, {
        id: "alice-task",
        contextId: "alice",
        status: { state: TaskState.WORKING },
      }),
      "agentos/assistant",
    ),
  );
  index.upsert(
    ingest(create(TaskSchema, { id: "bob-task", contextId: "bob" }), "agentos/assistant"),
  );
  index.flush();
  const view = vi.fn(() =>
    create(WatchConversationResponseSchema, {
      conversation: { title: `update-${view.mock.calls.length}` },
    }),
  );
  const controller = new AbortController();
  const stream = watch(
    { index, healthy: () => true },
    WatchConversationResponseSchema,
    controller.signal,
    view,
    { scope: new ObservationScope(index, { contextId: "alice" }) },
  );
  await stream.next();
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(300);
  index.invalidate("bob-task");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(view).toHaveBeenCalledOnce();
  index.invalidate("alice-task");
  await vi.advanceTimersByTimeAsync(1);
  await next;
  expect(view).toHaveBeenCalledTimes(2);
  controller.abort();
  await stream.return(undefined);
});

it("retains delegation events arriving while an asynchronous projection is in progress", async () => {
  vi.useFakeTimers();
  const index = new TaskIndex();
  const parent = ingest(
    create(TaskSchema, { id: "parent", contextId: "chat" }),
    "agentos/assistant",
  );
  index.upsert(parent);
  index.flush();
  let resolve = () => {};
  const pause = new Promise<void>((done) => {
    resolve = done;
  });
  const view = vi.fn(async () => {
    const title = index.entry("child") ? "delegated" : "initial";
    await pause;
    return create(WatchConversationResponseSchema, { conversation: { title } });
  });
  const controller = new AbortController();
  const stream = watch(
    { index, healthy: () => true },
    WatchConversationResponseSchema,
    controller.signal,
    view,
    { scope: new ObservationScope(index, { contextId: "chat" }) },
  );
  const first = stream.next();
  index.upsert({
    ...parent,
    version: "delegating",
    calls: [
      {
        id: "dispatch",
        name: "invoke_session",
        intent: "",
        returned: false,
        state: ActivityState.WORKING,
        delegation: {
          kind: "invoke",
          sessionId: "child-session",
          messageId: "",
          taskId: "",
          agentName: "inspection",
        },
      },
    ],
  });
  index.flush();
  index.upsert(
    ingest(create(TaskSchema, { id: "child", contextId: "child-session" }), "agentos/inspection"),
  );
  index.flush();
  resolve();
  expect((await first).value?.conversation?.title).toBe("initial");
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(251);
  expect((await next).value?.conversation?.title).toBe("delegated");
  expect(view).toHaveBeenCalledTimes(2);
  controller.abort();
  await stream.return(undefined);
});
