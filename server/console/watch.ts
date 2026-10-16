import { setTimeout as delay } from "node:timers/promises";
import { type DescMessage, equals, type MessageShape } from "@bufbuild/protobuf";
import type { KagentSync } from "../read-model/sync.js";
import { unavailable } from "../shared/errors.js";

const settle = 250;
const healthCheck = 5_000;
// Streams end periodically so intermediaries never hold idle responses indefinitely.
const lifetime = 5 * 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal }).catch((error: unknown) => {
    if (!signal.aborted) throw error;
  });

/** Yields the current view, then a new view whenever the read model changes it. */
export async function* watch<Desc extends DescMessage>(
  sync: KagentSync,
  schema: Desc,
  signal: AbortSignal,
  view: () => MessageShape<Desc> | Promise<MessageShape<Desc>>,
  poll = false,
): AsyncGenerator<MessageShape<Desc>> {
  let changed = true;
  let wake = () => {};
  const unsubscribe = sync.index.onChange(() => {
    changed = true;
    wake();
  });
  const deadline = Date.now() + lifetime;
  let last: MessageShape<Desc> | undefined;
  try {
    while (!signal.aborted && Date.now() < deadline) {
      if (!sync.healthy()) throw unavailable();
      if (changed) {
        changed = false;
        const next = await view();
        if (!last || !equals(schema, last, next)) {
          last = next;
          yield next;
        }
        await sleep(settle, signal);
        continue;
      }
      const stop = new AbortController();
      wake = () => stop.abort();
      await sleep(healthCheck, AbortSignal.any([signal, stop.signal]));
      if (poll) changed = true;
      wake = () => {};
    }
  } finally {
    unsubscribe();
  }
}
