import { useQuery } from "@connectrpc/connect-query";
import { ArrowUpRight, LoaderCircle, TicketCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { Interaction } from "../../../gen/agentos/console/v1/task_pb.js";
import { ChangeState } from "../../../gen/agentos/governance/v1/change_pb.js";
import { Failure } from "../management/ResourcePage.js";

export function ChangeOrders({ interaction }: { interaction: Interaction }) {
  const { t } = useTranslation();
  const result = useQuery(
    ConsoleService.method.listChanges,
    { taskId: interaction.taskId, requestId: interaction.requestId },
    {
      refetchInterval: (query) =>
        query.state.data?.changes.length &&
        query.state.data.changes.every((change) =>
          [
            ChangeState.SUCCEEDED,
            ChangeState.FAILED,
            ChangeState.EXPIRED,
            ChangeState.REJECTED,
          ].includes(change.state),
        )
          ? false
          : 2000,
    },
  );
  const changes = result.data?.changes ?? [];
  return (
    <div className="space-y-2" data-testid="change-orders">
      <Failure error={result.error} />
      {!changes.length && !result.error && (
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
      )}
      {changes.map((change) => (
        <div
          key={change.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-xs"
        >
          <TicketCheck className="size-4" />
          <span>{t(`operations.states.${ChangeState[change.state]}`)}</span>
          <span className="text-muted-foreground">{change.decidedBy || t("operations.human")}</span>
          <Button variant="link" size="sm" className="ml-auto h-auto p-0 text-xs" asChild>
            <a href={change.ticketUrl} target="_blank" rel="noreferrer">
              #{change.ticketId}
              <ArrowUpRight className="size-3" />
            </a>
          </Button>
          {change.reason && <p className="w-full leading-5">{change.reason}</p>}
        </div>
      ))}
    </div>
  );
}
