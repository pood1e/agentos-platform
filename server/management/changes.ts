import { Code, ConnectError } from "@connectrpc/connect";
import { conflict, fail } from "../shared/errors.js";
import { meta, optional } from "./native.js";
import type { ResourceStore } from "./resources.js";

/** Preflights native schemas; compensation preserves concurrent edits through resourceVersion. */
export async function resourceChanges<T>(
  store: ResourceStore,
  apply: (target: ResourceStore) => Promise<T>,
) {
  await apply({
    ...store,
    save: (kind, value, create) => store.validate(kind, value, create),
    credential: (name, value, owner) => store.credential(name, value, owner, true),
  });
  const undo: (() => Promise<void>)[] = [];
  let uncertain = false;
  async function write<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (
        [
          Code.Unavailable,
          Code.DeadlineExceeded,
          Code.Unknown,
          Code.Canceled,
          Code.Internal,
        ].includes(ConnectError.from(error).code)
      )
        uncertain = true;
      throw error;
    }
  }
  try {
    return await apply({
      ...store,
      async save(kind, value, create) {
        const name = String(meta(value).name);
        const previous = create ? undefined : await store.get(kind, name);
        const saved = await write(() => store.save(kind, value, create));
        undo.push(async () => {
          const latest = await optional(store, kind, name);
          if (!latest && !previous) return;
          if (!latest || meta(latest).resourceVersion !== meta(saved).resourceVersion)
            throw conflict("configuration.conflict");
          if (previous)
            await store.save(
              kind,
              {
                ...previous,
                metadata: { ...meta(previous), resourceVersion: meta(saved).resourceVersion },
              },
              false,
            );
          else await store.remove(kind, name, String(meta(saved).resourceVersion));
        });
        return saved;
      },
      async credential(name, value, owner) {
        const restore = await write(() => store.credential(name, value, owner));
        undo.push(restore);
        return restore;
      },
    });
  } catch (error) {
    const failures: unknown[] = [];
    for (const restore of undo.reverse()) {
      try {
        await restore();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (uncertain || failures.length)
      throw fail(Code.Aborted, "management.partialSave", new AggregateError([error, ...failures]));
    throw error;
  }
}
