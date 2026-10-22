import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  type MemoryService,
  MemorySummarySchema,
  type SessionMemoryInput,
} from "../../gen/kagent/runtime/v1/memory_pb.js";

export class FakeMemory {
  readonly records = new Map<
    string,
    { input: SessionMemoryInput; agentName: string; userId: string; accesses: bigint }
  >();
  reset() {
    this.records.clear();
  }
  service(): ServiceImpl<typeof MemoryService> {
    const user = (context: HandlerContext) => context.requestHeader.get("x-user-id") ?? "";
    const matches = (agentName: string, userId: string) =>
      [...this.records].filter(
        ([, item]) => item.agentName === agentName && item.userId === userId,
      );
    return {
      addSession: ({ memory, managementAgent }, context) => {
        if (!memory) throw new Error("Missing memory");
        const id = randomUUID();
        this.records.set(id, {
          input: memory,
          agentName: managementAgent,
          userId: user(context),
          accesses: 0n,
        });
        return { id };
      },
      addSessionBatch: ({ items, managementAgent }, context) => {
        for (const input of items)
          this.records.set(randomUUID(), {
            input,
            agentName: managementAgent,
            userId: user(context),
            accesses: 0n,
          });
        return { count: items.length };
      },
      list: (scope, context) => ({
        memories: matches(scope.agentName, user(context)).map(([id, item]) =>
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
        memories: matches(scope.managementAgent, user(context))
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
        for (const [id] of matches(scope.agentName, user(context))) this.records.delete(id);
        return { status: "ok" };
      },
      deleteEntry: (scope, context) => {
        if (!matches(scope.agentName, user(context)).some(([id]) => id === scope.id))
          throw new ConnectError("Memory not found", Code.NotFound);
        this.records.delete(scope.id);
        return {};
      },
    };
  }
}
