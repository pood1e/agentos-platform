import { Code, ConnectError } from "@connectrpc/connect";
import type { ExecutionBinding } from "../../gen/agentos/execution/v1/identity_pb.js";
import { chainLimit, type ExecutionStore } from "../../server/authorization/store.js";

export function memoryStore(): ExecutionStore {
  const bindings = new Map(),
    identities = new Map();
  const read = async (values: Map<string, { value: object; version: string }>, id: string) =>
    structuredClone(values.get(id));
  const save = async (
    values: Map<string, { value: object; version: string }>,
    id: string,
    value: object,
    version?: string,
  ) => {
    if (values.get(id)?.version !== version) throw new ConnectError("Conflict", Code.Aborted);
    values.set(id, { value: structuredClone(value), version: String(Number(version ?? 0) + 1) });
  };
  const locked = new Set<string>();
  return {
    async exclusive(key, run) {
      if (locked.has(key)) throw new ConnectError("Busy", Code.Aborted);
      locked.add(key);
      try {
        return await run();
      } finally {
        locked.delete(key);
      }
    },
    async inventory(filter = {}) {
      return [...bindings.values()]
        .map((row) => structuredClone(row.value) as ExecutionBinding)
        .filter((row) => !filter.roots || filter.roots.includes(row.rootSessionId))
        .filter(
          (row) =>
            filter.subject === undefined ||
            row.subject === filter.subject ||
            (filter.services && row.subject.startsWith("service:")),
        )
        .filter((row) => !filter.systemOnly || row.subject.startsWith("service:"));
    },
    binding: (id) => read(bindings, id),
    chain: async (id) => {
      const chain: ExecutionBinding[] = [];
      for (let row = bindings.get(id)?.value; row && chain.length < chainLimit; ) {
        chain.push(structuredClone(row));
        if (row.sessionId === row.rootSessionId) break;
        row = bindings.get(row.parentSessionId)?.value;
      }
      return chain;
    },
    bindings: async (ids) =>
      ids.flatMap((id) => {
        const row = bindings.get(id);
        return row ? [structuredClone(row.value)] : [];
      }),
    identity: (id) => read(identities, id),
    saveBinding: (value, version) => save(bindings, value.sessionId, value, version),
    saveIdentity: (value, version) => save(identities, value.subject, value, version),
    updateIdentity: async (subject, update) => {
      const stored = identities.get(subject);
      if (!stored) return undefined;
      const next = await update(structuredClone(stored.value));
      await save(identities, subject, next, stored.version);
      return next;
    },
  } as ExecutionStore;
}
