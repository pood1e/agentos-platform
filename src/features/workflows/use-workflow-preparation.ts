import { useQuery } from "@tanstack/react-query";
import type { Workflow } from "../../../gen/agentos/management/v1/workflow_pb.js";
import { object, text } from "../../../shared/json.js";
import { useAccess } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";

export function useWorkflowPreparation(base: Workflow, isNew: boolean) {
  const access = useAccess().data;
  const query = useQuery({
    queryKey: [
      "workflows",
      "ready",
      base.agent?.ref?.namespace,
      access?.subject,
      base.agent?.ref?.name,
    ],
    queryFn: () => managementClient.getWorkflow({ ref: base.agent?.ref }),
    enabled: !isNew,
    refetchInterval: 3000,
  });
  const status = object(query.data?.workflow?.agent?.resource?.value?.status);
  const conditions = status.conditions;
  const condition = Array.isArray(conditions)
    ? conditions.map(object).find((condition) => condition.type === "Ready")
    : undefined;
  const ready =
    condition?.status === "True" &&
    !!base.preparedRevision &&
    text(status.latestSuccessfulRevision) === base.preparedRevision &&
    query.data?.workflow?.preparedRevision === base.preparedRevision;
  return { query, ready, condition };
}
