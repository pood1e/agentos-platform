import { setTimeout as delay } from "node:timers/promises";
import { type DescMessage, equals, type MessageShape } from "@bufbuild/protobuf";
import type { ObservationScope } from "../read-model/observation.js";
import type { KagentSync } from "../read-model/sync.js";
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

/** Yields the current view, then a new view whenever the read model changes it. */
export async function* watch<Desc extends DescMessage>(
  sync: Pick<KagentSync, "index" | "healthy">,
  schema: Desc,
  signal: AbortSignal,
  view: () => MessageShape<Desc> | Promise<MessageShape<Desc>>,
  options: { poll?: boolean; scope?: ObservationScope } = {},
): AsyncGenerator<MessageShape<Desc>> {
  let changed = true;
  let wake = () => {};
  let projecting = false;
  const pending = new Set<string>();
  const unsubscribe = sync.index.onChange((ids) => {
    if (projecting) {
      for (const id of ids) pending.add(id);
      return;
    }
    if (options.scope && !options.scope.affects(ids)) return;
    changed = true;
    wake();
  });
  const deadline = Date.now() + lifetime;
  let last: MessageShape<Desc> | undefined;
  let sentAt = 0;
  try {
    while (!signal.aborted && Date.now() < deadline) {
      if (!sync.healthy()) throw unavailable();
      if (changed) {
        changed = false;
        projecting = true;
        options.scope?.refresh();
        const next = await view();
        options.scope?.refresh();
        projecting = false;
        if (pending.size && (!options.scope || options.scope.affects(pending))) changed = true;
        pending.clear();
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
        if (!sync.healthy()) throw unavailable();
        sentAt = Date.now();
        yield last;
      }
      if (options.poll) changed = true;
      wake = () => {};
    }
  } finally {
    unsubscribe();
  }
}
