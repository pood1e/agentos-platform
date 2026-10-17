import { type CallOptions, Code, ConnectError } from "@connectrpc/connect";
import type { OperationsConfig } from "../../gen/agentos/governance/v1/change_pb.js";
import type { KagentSync } from "../read-model/sync.js";
import { changeId } from "../shared/change-digest.js";
import { notFound } from "../shared/errors.js";
import { changeClient } from "./client.js";
import { environmentFor } from "./requests.js";

export async function changes(
  sync: KagentSync,
  config: OperationsConfig,
  taskId: string,
  requestId: string,
  options?: CallOptions,
) {
  const entry = sync.index.entry(taskId);
  const interaction = entry?.interactions.find((item) => item.requestId === requestId);
  if (!entry || !interaction) throw notFound("interaction.stale");
  const records = await Promise.all(
    interaction.tools.map(async (tool) => {
      const connection = environmentFor(config.environments, tool.name);
      if (!connection) return undefined;
      try {
        const { result } = await changeClient(connection).getChange(
          { id: changeId(entry.id, tool.id) },
          options,
        );
        return result?.change;
      } catch (error) {
        if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
        throw error;
      }
    }),
  );
  return { changes: records.flatMap((record) => record ?? []) };
}
