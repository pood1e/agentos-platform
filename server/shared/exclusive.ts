import { conflict } from "./errors.js";

/** Rejects overlapping commands for the same resource while allowing independent work. */
export function exclusiveCommands() {
  const inflight = new Set<string>();
  return async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    if (inflight.has(key)) throw conflict("chat.busy");
    inflight.add(key);
    try {
      return await run();
    } finally {
      inflight.delete(key);
    }
  };
}
