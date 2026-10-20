import { Code, ConnectError } from "@connectrpc/connect";
import type { ExecutionStore } from "../../server/authorization/store.js";

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
  return {
    binding: (id) => read(bindings, id),
    bindings: async (ids) =>
      ids.flatMap((id) => {
        const row = bindings.get(id);
        return row ? [structuredClone(row.value)] : [];
      }),
    identity: (id) => read(identities, id),
    saveBinding: (value, version) => save(bindings, value.sessionId, value, version),
    saveIdentity: (value, version) => save(identities, value.subject, value, version),
  } as ExecutionStore;
}
