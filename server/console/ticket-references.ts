import { clone, create } from "@bufbuild/protobuf";
import { LRUCache } from "lru-cache";
import {
  InteractionKind,
  InteractionSchema,
  type TaskDetail,
} from "../../gen/agentos/console/v1/task_pb.js";
import {
  type Change,
  ChangeSchema,
  ChangeState,
  type OperationsConfig,
} from "../../gen/agentos/governance/v1/change_pb.js";
import { changes } from "../operations/views.js";
import type { KagentSync } from "../read-model/sync.js";

/** Enriches HITL records with native ticket identity without copying private request payloads. */
export function ticketReferences(sync: KagentSync, operations: OperationsConfig) {
  const records = new LRUCache<string, Change[]>({
    max: 2048,
    ttl: 5_000,
    allowStaleOnFetchRejection: true,
    noDeleteOnFetchRejection: true,
    fetchMethod: async (key, _stale, { options }) => {
      const [taskId = "", requestId = ""] = key.split("\0");
      const result = await changes(sync, operations, taskId, requestId, { timeoutMs: 2_000 });
      const refs = result.changes.map((change) =>
        create(ChangeSchema, {
          id: change.id,
          environment: change.environment,
          ticketId: change.ticketId,
          ticketUrl: change.ticketUrl,
          state: change.state,
        }),
      );
      if (
        refs.length &&
        refs.every((change) =>
          [
            ChangeState.SUCCEEDED,
            ChangeState.FAILED,
            ChangeState.REJECTED,
            ChangeState.CANCELED,
          ].includes(change.state),
        )
      )
        options.ttl = 60_000;
      return refs;
    },
  });
  return async (task: TaskDetail) => {
    task.interactions = await Promise.all(
      task.interactions.map(async (interaction) => {
        if (interaction.kind !== InteractionKind.APPROVAL) return interaction;
        const references = await records
          .fetch(`${interaction.taskId}\0${interaction.requestId}`, { allowStale: true })
          .catch(() => undefined);
        if (!references?.length) return interaction;
        const enriched = clone(InteractionSchema, interaction);
        enriched.changes = references;
        return enriched;
      }),
    );
    return task;
  };
}
