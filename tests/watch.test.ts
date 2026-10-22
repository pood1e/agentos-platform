import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it, vi } from "vitest";
import { WatchConversationResponseSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { watch } from "../server/console/watch.js";
import { TaskIndex } from "../server/read-model/index.js";

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
