import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useQuery } from "@connectrpc/connect-query";
import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import {
  type ScheduledRun,
  ScheduledRunExecutionState,
} from "../../../gen/kagent/api/v1/scheduled_runs_pb.js";
import { Failure } from "../shared/ResourcePage.js";

const states: Record<ScheduledRunExecutionState, string> = {
  [ScheduledRunExecutionState.UNSPECIFIED]: "pending",
  [ScheduledRunExecutionState.PENDING]: "pending",
  [ScheduledRunExecutionState.RUNNING]: "running",
  [ScheduledRunExecutionState.SUCCEEDED]: "succeeded",
  [ScheduledRunExecutionState.FAILED]: "failed",
  [ScheduledRunExecutionState.TIMED_OUT]: "timedOut",
};

/** Recent firings; each opens the native execution it started. */
export function ScheduleExecutions({ run }: { run: ScheduledRun }) {
  const { t, i18n } = useTranslation();
  const executions = useQuery(ConsoleService.method.listScheduledRunExecutions, {
    scheduledRunId: run.id,
    page: { limit: 50 },
  });
  const time = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "short",
    timeStyle: "short",
  });
  if (executions.isPending)
    return <LoaderCircle className="mx-auto animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-4">
      <Failure error={executions.error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("schedule.triggeredAt")}</TableHead>
            <TableHead>{t("schedule.state")}</TableHead>
            <TableHead>{t("schedule.result")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {executions.data?.executions.map((execution) => {
            const at =
              execution.trigger.case === "scheduledTime"
                ? execution.trigger.value
                : execution.createdAt;
            return (
              <TableRow key={execution.id}>
                <TableCell className="text-xs tabular-nums">
                  {at && time.format(timestampDate(at))}
                  {execution.trigger.case === "manualRequestId" && (
                    <span className="ml-2 text-muted-foreground">{t("schedule.manual")}</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {t(`schedule.states.${states[execution.state]}`)}
                </TableCell>
                <TableCell className="max-w-64 truncate text-xs">
                  {execution.sessionId ? (
                    <Link
                      className="hover:underline"
                      to={`/executions/${encodeURIComponent(run.agent?.name ?? "")}/${encodeURIComponent(execution.sessionId)}`}
                    >
                      {execution.failureReason || t("schedule.openExecution")}
                    </Link>
                  ) : (
                    execution.failureReason || "—"
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {!executions.data?.executions.length && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t("schedule.noExecutions")}
        </p>
      )}
    </div>
  );
}
