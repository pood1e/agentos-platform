import { create } from "@bufbuild/protobuf";
import type { CallOptions } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ApprovalReferenceSchema,
  type GovernanceConfig,
} from "../../gen/agentos/governance/v1/governance_pb.js";
import type { EnvironmentTokens } from "../authorization/environment-tokens.js";
import type { TaskProjection } from "../read-model/projection.js";
import { notFound } from "../shared/errors.js";
import { approvalClient, approvalEnvironment } from "./client.js";

export async function approvals(
  projection: Pick<TaskProjection, "entry">,
  config: GovernanceConfig,
  taskId: string,
  requestId: string,
  options?: CallOptions,
  token?: EnvironmentTokens,
) {
  const entry = await projection.entry(taskId);
  const interaction = entry?.interactions.find((item) => item.requestId === requestId);
  if (!entry || !interaction) throw notFound("interaction.stale");
  const records = await Promise.all(
    interaction.tools.map(async (tool) => {
      const connection = approvalEnvironment(config.environments, tool.name);
      if (!connection?.approvalUrl) return undefined;
      try {
        const reference = create(ApprovalReferenceSchema, { taskId, toolId: tool.id });
        const { approval } = await approvalClient(connection, token).getApproval(
          { reference },
          options,
        );
        if (approval) approval.reference = reference;
        return approval;
      } catch (error) {
        if (ConnectError.from(error).code === Code.NotFound)
          return interaction.approvals.find((record) => record.reference?.toolId === tool.id);
        throw error;
      }
    }),
  );
  return { approvals: records.flatMap((record) => record ?? []) };
}
