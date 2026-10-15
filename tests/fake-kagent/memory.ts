import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import {
  type MemoryService,
  MemorySummarySchema,
  type SessionMemoryInput,
} from "../../gen/kagent/api/v1alpha1/memory_pb.js";

export class FakeMemory {
  readonly records = new Map<string, { input: SessionMemoryInput; accesses: bigint }>();
  reset() {
    this.records.clear();
  }
  service(): ServiceImpl<typeof MemoryService> {
    const matches = (scope: { agentName: string; userId: string }) =>
      [...this.records].filter(
        ([, item]) =>
          item.input.agentName === scope.agentName && item.input.userId === scope.userId,
      );
    return {
      addSession: ({ memory }) => {
        if (!memory) throw new Error("Missing memory");
        const id = randomUUID();
        this.records.set(id, { input: memory, accesses: 0n });
        return { id };
      },
      addSessionBatch: ({ items }) => {
        for (const input of items) this.records.set(randomUUID(), { input, accesses: 0n });
        return { count: items.length };
      },
      list: (scope) => ({
        memories: matches(scope).map(([id, item]) =>
          create(MemorySummarySchema, {
            id,
            content: item.input.content,
            accessCount: item.accesses,
            createdAt: timestampFromMs(Date.now()),
            expiresAt: timestampFromMs(Date.now() + 86400_000),
          }),
        ),
      }),
      search: (scope) => ({
        memories: matches(scope)
          .slice(0, scope.limit ?? 20)
          .map(([id, item]) => {
            item.accesses++;
            return {
              id,
              content: item.input.content,
              score: 0.9,
              metadata: item.input.metadata,
              createdAt: timestampFromMs(Date.now()),
            };
          }),
      }),
      delete: (scope) => {
        for (const [id] of matches(scope)) this.records.delete(id);
        return { status: "ok" };
      },
      deleteEntry: (scope) => {
        if (!matches(scope).some(([id]) => id === scope.id))
          throw new ConnectError("Memory not found", Code.NotFound);
        this.records.delete(scope.id);
        return {};
      },
    };
  }
}
