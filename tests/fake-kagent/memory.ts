import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  type MemoryScope,
  type MemoryService,
  MemorySummarySchema,
  type SessionMemoryInput,
} from "../../gen/kagent/runtime/v1/memory_pb.js";

export class FakeMemory {
  readonly records = new Map<
    string,
    { input: SessionMemoryInput; scope: string; accesses: bigint }
  >();
  reset() {
    this.records.clear();
  }
  service(): ServiceImpl<typeof MemoryService> {
    const user = (context: HandlerContext) => context.requestHeader.get("x-user-id") ?? "";
    const key = (scope: MemoryScope | undefined, context: HandlerContext) =>
      scope?.target.case === "teamNamespace"
        ? `team:${scope.target.value}`
        : `personal:${scope?.target.value}:${user(context)}`;
    const matches = (scope: MemoryScope | undefined, context: HandlerContext) =>
      [...this.records].filter(([, item]) => item.scope === key(scope, context));
    return {
      addSession: ({ memory, scope }, context) => {
        if (!memory) throw new Error("Missing memory");
        const id = randomUUID();
        this.records.set(id, {
          input: memory,
          scope: key(scope, context),
          accesses: 0n,
        });
        return { id };
      },
      addSessionBatch: ({ items, scope }, context) => {
        for (const input of items)
          this.records.set(randomUUID(), {
            input,
            scope: key(scope, context),
            accesses: 0n,
          });
        return { count: items.length };
      },
      list: (scope, context) => ({
        memories: matches(scope.scope, context).map(([id, item]) =>
          create(MemorySummarySchema, {
            id,
            content: item.input.content,
            accessCount: item.accesses,
            createdAt: timestampFromMs(Date.now()),
            expiresAt: timestampFromMs(Date.now() + 86400_000),
          }),
        ),
      }),
      search: (scope, context) => ({
        memories: matches(scope.scope, context)
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
      delete: (scope, context) => {
        for (const [id] of matches(scope.scope, context)) this.records.delete(id);
        return { status: "ok" };
      },
      deleteEntry: (scope, context) => {
        if (!matches(scope.scope, context).some(([id]) => id === scope.id))
          throw new ConnectError("Memory not found", Code.NotFound);
        this.records.delete(scope.id);
        return {};
      },
    };
  }
}
