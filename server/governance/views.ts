import type { CallOptions } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import type { KagentSync } from "../read-model/sync.js";
import { notFound } from "../shared/errors.js";
import { approvalClient, approvalEnvironment } from "./client.js";

export async function approvals(
  sync: KagentSync,
  config: GovernanceConfig,
  taskId: string,
  requestId: string,
  options?: CallOptions,
) {
  const entry = sync.index.entry(taskId);
  const interaction = entry?.interactions.find((item) => item.requestId === requestId);
  if (!entry || !interaction) throw notFound("interaction.stale");
  const records = await Promise.all(
    interaction.tools.map(async (tool) => {
      const connection = approvalEnvironment(config.environments, tool.name);
      if (!connection?.approvalUrl) return undefined;
      try {
        return (
          await approvalClient(connection).getApproval(
            { reference: { taskId, toolId: tool.id } },
            options,
          )
        ).approval;
      } catch (error) {
        if (ConnectError.from(error).code === Code.NotFound) return undefined;
        throw error;
      }
    }),
  );
  return { approvals: records.flatMap((record) => record ?? []) };
}
