import { useQuery } from "@connectrpc/connect-query";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { Interaction } from "../../../gen/agentos/console/v1/task_pb.js";
import { active, awaiting } from "../status/activity.js";

export function useExternalApprovals(interaction: Interaction) {
  return useQuery(
    ConsoleService.method.listApprovals,
    { taskId: interaction.taskId, requestId: interaction.requestId },
    {
      enabled: interaction.external,
      refetchInterval: (query) =>
        awaiting(interaction.state) ||
        query.state.data?.approvals.some((item) => active(item.state))
          ? 2_000
          : false,
    },
  );
}
