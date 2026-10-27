import { clone } from "@bufbuild/protobuf";
import { LRUCache } from "lru-cache";
import {
  type Interaction,
  InteractionKind,
  InteractionSchema,
} from "../../gen/agentos/console/v1/task_pb.js";
import type { Approval, GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import type { EnvironmentTokens } from "../authorization/environment-tokens.js";
import { approvalEnvironment } from "../governance/client.js";
import { approvals } from "../governance/views.js";
import type { TaskProjection } from "../read-model/projection.js";

export function approvalReferences(
  projection: Pick<TaskProjection, "entry">,
  governance: GovernanceConfig,
  token?: EnvironmentTokens,
) {
  const records = new LRUCache<string, Approval[]>({
    max: 2048,
    ttl: 5_000,
    allowStaleOnFetchRejection: true,
    noDeleteOnFetchRejection: true,
    fetchMethod: async (key) => {
      const [taskId = "", requestId = ""] = key.split("\0");
      return (
        await approvals(projection, governance, taskId, requestId, { timeoutMs: 2_000 }, token)
      ).approvals;
    },
  });
  return async <T extends { interactions: Interaction[] }>(task: T): Promise<T> => {
    task.interactions = await Promise.all(
      task.interactions.map(async (interaction) => {
        if (interaction.kind !== InteractionKind.APPROVAL) return interaction;
        const external = interaction.tools.some(
          (tool) => approvalEnvironment(governance.environments, tool.name)?.approvalUrl,
        );
        if (!external) return interaction;
        const enriched = clone(InteractionSchema, interaction);
        enriched.external = true;
        enriched.approve = false;
        enriched.approvals =
          (await records
            .fetch(`${interaction.taskId}\0${interaction.requestId}`, { allowStale: true })
            .catch(() => undefined)) ?? [];
        return enriched;
      }),
    );
    return task;
  };
}
