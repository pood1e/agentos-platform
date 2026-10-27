import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it, vi } from "vitest";
import { WatchConversationResponseSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { watch } from "../server/console/watch.js";
import type { ProjectionChange } from "../server/read-model/store.js";

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

function projection(healthy = () => true) {
  const listeners = new Set<(change: ProjectionChange) => void>();
  return {
    healthy,
    onChange(listener: (change: ProjectionChange) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commit(...roots: string[]) {
      for (const listener of listeners) listener({ roots, ids: [] });
    },
  };
}

it("keeps unchanged observations alive without reloading the view and cancels pending timers", async () => {
  vi.useFakeTimers();
  const value = create(WatchConversationResponseSchema, { conversation: { title: "交换机巡检" } });
  const view = vi.fn(() => value);
  const controller = new AbortController();
  const stream = watch(projection(), WatchConversationResponseSchema, controller.signal, view);
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
  const view = vi.fn(() => create(WatchConversationResponseSchema));
  const stream = watch(
    projection(() => healthy),
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

it("ignores other execution trees while observing the selected conversation", async () => {
  vi.useFakeTimers();
  const changes = projection();
  const view = vi.fn(() =>
    create(WatchConversationResponseSchema, {
      conversation: { title: `update-${view.mock.calls.length}` },
    }),
  );
  const controller = new AbortController();
  const stream = watch(changes, WatchConversationResponseSchema, controller.signal, view, {
    roots: () => new Set(["alice"]),
  });
  await stream.next();
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(300);
  changes.commit("bob");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(view).toHaveBeenCalledOnce();
  changes.commit("alice");
  await vi.advanceTimersByTimeAsync(1);
  await next;
  expect(view).toHaveBeenCalledTimes(2);
  controller.abort();
  await stream.return(undefined);
});

it("retains changes committed while an asynchronous view is in progress", async () => {
  vi.useFakeTimers();
  const changes = projection();
  let delegated = false;
  let resolve = () => {};
  const pause = new Promise<void>((done) => {
    resolve = done;
  });
  const view = vi.fn(async () => {
    const title = delegated ? "delegated" : "initial";
    await pause;
    return create(WatchConversationResponseSchema, { conversation: { title } });
  });
  const controller = new AbortController();
  const stream = watch(changes, WatchConversationResponseSchema, controller.signal, view, {
    roots: () => new Set(["chat"]),
  });
  const first = stream.next();
  delegated = true;
  changes.commit("chat");
  resolve();
  expect((await first).value?.conversation?.title).toBe("initial");
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(251);
  expect((await next).value?.conversation?.title).toBe("delegated");
  expect(view).toHaveBeenCalledTimes(2);
  controller.abort();
  await stream.return(undefined);
});

it("wakes on live task deltas registered by the view", async () => {
  vi.useFakeTimers();
  let delta = () => {};
  const release = vi.fn();
  const view = vi.fn(() =>
    create(WatchConversationResponseSchema, {
      conversation: { title: `delta-${view.mock.calls.length}` },
    }),
  );
  const controller = new AbortController();
  const stream = watch(projection(), WatchConversationResponseSchema, controller.signal, view, {
    roots: () => new Set(["chat"]),
    wakes: (touch) => {
      delta = touch;
      return release;
    },
  });
  await stream.next();
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(300);
  delta();
  await vi.advanceTimersByTimeAsync(1);
  expect((await next).value?.conversation?.title).toBe("delta-2");
  controller.abort();
  await stream.return(undefined);
  expect(release).toHaveBeenCalledOnce();
});
