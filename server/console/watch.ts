import { setTimeout as delay } from "node:timers/promises";
import { type DescMessage, equals, type MessageShape } from "@bufbuild/protobuf";
import type { TaskProjection } from "../read-model/projection.js";
import { unavailable } from "../shared/errors.js";

const settle = 250;
const healthCheck = 5_000;
const heartbeat = 15_000;
// Streams end periodically so intermediaries never hold idle responses indefinitely.
const lifetime = 5 * 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal }).catch((error: unknown) => {
    if (!signal.aborted) throw error;
  });

export interface WatchOptions {
  /** Execution trees the view depends on; any change wakes the view while unknown. */
  roots?: () => ReadonlySet<string> | undefined;
  /** Registers other change sources, such as live task streams; returns their cleanup. */
  wakes?: (touch: () => void) => () => void;
  poll?: boolean;
}

/** Yields the current view, then a new view whenever its execution trees change. */
export async function* watch<Desc extends DescMessage>(
  projection: Pick<TaskProjection, "onChange" | "healthy">,
  schema: Desc,
  signal: AbortSignal,
  view: () => MessageShape<Desc> | Promise<MessageShape<Desc>>,
  options: WatchOptions = {},
): AsyncGenerator<MessageShape<Desc>> {
  let changed = true;
  let wake = () => {};
  const touch = () => {
    changed = true;
    wake();
  };
  const unsubscribe = projection.onChange((change) => {
    const roots = options.roots?.();
    if (!roots || change.roots.some((root) => roots.has(root))) touch();
  });
  const release = options.wakes?.(touch);
  const deadline = Date.now() + lifetime;
  let last: MessageShape<Desc> | undefined;
  let sentAt = 0;
  try {
    while (!signal.aborted && Date.now() < deadline) {
      if (!projection.healthy()) throw unavailable();
      if (changed) {
        changed = false;
        const next = await view();
        if (!last || !equals(schema, last, next)) {
          last = next;
          sentAt = Date.now();
          yield next;
        }
        await sleep(settle, signal);
        continue;
      }
      const stop = new AbortController();
      wake = () => stop.abort();
      await sleep(healthCheck, AbortSignal.any([signal, stop.signal]));
      if (!signal.aborted && last && Date.now() - sentAt >= heartbeat) {
        if (!projection.healthy()) throw unavailable();
        sentAt = Date.now();
        yield last;
      }
      if (options.poll) changed = true;
      wake = () => {};
    }
  } finally {
    unsubscribe();
    release?.();
  }
}
