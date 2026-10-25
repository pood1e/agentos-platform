import { clone } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ListApprovalRequestsRequest } from "../../gen/agentos/console/v1/console_service_pb.js";
import { InteractionKind, InteractionSchema } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import type { GovernanceConfig } from "../../gen/agentos/governance/v1/governance_pb.js";
import { approvalEnvironment } from "../governance/client.js";
import type { TaskIndex } from "../read-model/index.js";
import { pageOf } from "../read-model/page.js";

/** Approval material is shared with reviewers; chat messages remain in the owner's history. */
export function approvalQueue(
  index: TaskIndex,
  config: GovernanceConfig,
  request: ListApprovalRequestsRequest,
  subject: string,
) {
  const states = [...new Set(request.states)].sort((a, b) => a - b);
  const key = (item: { id: string; requestedAt?: Parameters<typeof timestampDate>[0] }) => ({
    id: item.id,
    time: item.requestedAt ? timestampDate(item.requestedAt).getTime() : 0,
  });
  const requests = index.all().flatMap((entry) =>
    entry.interactions
      .filter((item) => item.kind === InteractionKind.APPROVAL)
      .map((item) => {
        const value = clone(InteractionSchema, item);
        value.external = value.tools.some(
          (tool) => approvalEnvironment(config.environments, tool.name)?.approvalUrl,
        );
        value.approve = false;
        return value;
      }),
  );
  const matches = requests
    .filter((item) => !states.length || states.includes(item.state))
    .sort((a, b) => key(b).time - key(a).time || a.id.localeCompare(b.id));
  const page = pageOf(
    matches,
    { ...request, query: "" },
    `approvals:${JSON.stringify([subject, states])}`,
    key,
  );
  return {
    requests: page.items,
    totalSize: page.totalSize,
    pendingCount: requests.filter((item) => item.state === ActivityState.AWAITING_APPROVAL).length,
    nextPageToken: page.nextPageToken,
  };
}
