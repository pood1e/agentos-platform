import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScheduledRunExecutionState } from "../../../gen/kagent/api/v1/scheduled_runs_pb.js";
import { automationClient } from "../../lib/console.js";
import { ResourceSheet } from "../management/ResourceDialog.js";
import { Failure } from "../management/ResourcePage.js";
import { PageControl } from "../shared/PageControl.js";
import { usePaging } from "../shared/paging.js";
import { scheduledTime } from "./format.js";
import { systemTaskLocation } from "./location.js";

export function ScheduleDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const paging = usePaging(id);
  const detail = useQuery({
    queryKey: ["system-tasks", "detail", id],
    queryFn: ({ signal }) => automationClient.getScheduledRun({ scheduledRunId: id }, { signal }),
    refetchInterval: 5_000,
  });
  const history = useQuery({
    queryKey: ["system-tasks", "history", id, paging.pageToken],
    queryFn: ({ signal }) =>
      automationClient.listScheduledRunExecutions(
        {
          scheduledRunId: id,
          page: { limit: paging.pageSize, pageToken: paging.pageToken },
        },
        { signal },
      ),
    refetchInterval: 3_000,
  });
  const schedule = detail.data?.scheduledRun;
  const next = history.data?.page?.nextPageToken;
  const page = paging.controls(next);
  return (
    <ResourceSheet
      open
      title={schedule?.config?.name || t("automation.history")}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="space-y-5">
        <Failure error={detail.error || history.error} />
        {schedule && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline">
                {t(
                  schedule.deletedAt
                    ? "automation.deleted"
                    : schedule.config?.paused
                      ? "automation.paused"
                      : "automation.active",
                )}
              </Badge>
              <Badge variant="secondary">{t("automation.readOnlyIdentity")}</Badge>
              <span>
                {schedule.config?.schedule} · {schedule.config?.timeZone}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{schedule.config?.prompt}</p>
          </>
        )}
        <h2 className="text-sm font-semibold">{t("automation.history")}</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("automation.started")}</TableHead>
              <TableHead>{t("automation.trigger")}</TableHead>
              <TableHead>{t("automation.status")}</TableHead>
              <TableHead>{t("automation.result")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.data?.executions.map((execution) => (
              <TableRow key={execution.id}>
                <TableCell className="whitespace-nowrap">
                  {scheduledTime(execution.createdAt, schedule?.config?.timeZone)}
                </TableCell>
                <TableCell>
                  {t(
                    execution.trigger.case === "scheduledTime"
                      ? "automation.scheduled"
                      : "automation.manual",
                  )}
                </TableCell>
                <TableCell>
                  {execution.awaitingDispatch &&
                  execution.state === ScheduledRunExecutionState.PENDING
                    ? t("automation.awaitingDispatch")
                    : t(`automation.states.${ScheduledRunExecutionState[execution.state]}`)}
                </TableCell>
                <TableCell>
                  {execution.taskId ? (
                    <Link
                      className="text-primary underline-offset-4 hover:underline"
                      to={systemTaskLocation(execution.taskId)}
                    >
                      {t("automation.viewExecution")}
                    </Link>
                  ) : (
                    "—"
                  )}
                  {execution.failureReason && (
                    <p className="mt-1 max-w-64 whitespace-normal break-words text-xs text-muted-foreground">
                      {execution.failureReason}
                    </p>
                  )}
                  {execution.dispatchReason && (
                    <p className="mt-1 max-w-64 whitespace-normal break-words text-xs text-muted-foreground">
                      {execution.dispatchReason}
                    </p>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {history.isSuccess && !history.data.executions.length && (
          <p className="text-sm text-muted-foreground">{t("automation.noExecutions")}</p>
        )}
        {(page.page > 0 || next) && (
          <PageControl
            page={page.page}
            hasNext={!!next}
            onPage={page.onPage}
            label={t("automation.history")}
            disabled={history.isFetching}
          />
        )}
      </div>
    </ResourceSheet>
  );
}
