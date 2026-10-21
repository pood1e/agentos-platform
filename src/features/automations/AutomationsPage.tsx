import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import type { ScheduledRun } from "../../../gen/kagent/api/v1alpha1/scheduled_runs_pb.js";
import { can } from "../../../shared/permissions.js";
import { useAccess } from "../../lib/access.js";
import { automationClient } from "../../lib/console.js";
import { ConfirmDelete, ResourceSheet } from "../management/ResourceDialog.js";
import { Failure } from "../management/ResourcePage.js";
import { roleLabel } from "../shared/engineers.js";
import { PageControl } from "../shared/PageControl.js";
import { usePaging } from "../shared/paging.js";
import { EventTriggers } from "./EventTriggers.js";
import { scheduledTime } from "./format.js";
import { ScheduleDetail } from "./ScheduleDetail.js";
import { ScheduleEditor } from "./ScheduleEditor.js";

export function AutomationsPage() {
  const { t } = useTranslation();
  const { scheduleId } = useParams();
  const navigate = useNavigate();
  const access = useAccess();
  const manage = can(access.data, Capability.TASKS_MANAGE);
  const query = useQueryClient();
  const paging = usePaging();
  const [editing, setEditing] = useState<{ schedule?: ScheduledRun }>();
  const [deleting, setDeleting] = useState<ScheduledRun>();
  const [manualIds] = useState(() => new Map<string, string>());
  const list = useQuery({
    queryKey: ["automations", "list", paging.pageToken],
    queryFn: ({ signal }) =>
      automationClient.listScheduledRuns(
        {
          page: { limit: paging.pageSize, pageToken: paging.pageToken },
        },
        { signal },
      ),
    refetchInterval: 5_000,
  });
  const refresh = () => query.invalidateQueries({ queryKey: ["automations"] });
  const action = useMutation({
    mutationFn: async ({ schedule, run }: { schedule: ScheduledRun; run: boolean }) => {
      if (run) {
        const requestId = manualIds.get(schedule.id) ?? crypto.randomUUID();
        manualIds.set(schedule.id, requestId);
        await automationClient.triggerScheduledRun({ scheduledRunId: schedule.id, requestId });
        manualIds.delete(schedule.id);
        void navigate(`/tasks/automations/${schedule.id}`);
      } else if (schedule.config)
        await automationClient.updateScheduledRun({
          scheduledRunId: schedule.id,
          etag: schedule.etag,
          config: { ...schedule.config, paused: !schedule.config.paused },
        });
    },
    onSuccess: refresh,
  });
  const next = list.data?.page?.nextPageToken;
  const page = paging.controls(next);
  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">
      <section className="space-y-3" aria-label={t("automation.schedules")}>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">{t("automation.schedules")}</h1>
          {manage && (
            <Button onClick={() => setEditing({})}>
              <Plus />
              {t("automation.create")}
            </Button>
          )}
        </div>
        <Failure error={list.error || action.error} />
        {list.isPending && (
          <p className="text-sm text-muted-foreground">{t("automation.loading")}</p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("automation.name")}</TableHead>
              <TableHead>{t("automation.agent")}</TableHead>
              <TableHead>{t("automation.status")}</TableHead>
              <TableHead>{t("automation.cadence")}</TableHead>
              <TableHead>{t("automation.nextExecution")}</TableHead>
              {manage && <TableHead className="text-right">{t("automation.actions")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.scheduledRuns.map((schedule) => (
              <TableRow key={schedule.id} data-testid="scheduled-run-row">
                <TableCell>
                  <Button
                    variant="link"
                    className="h-auto max-w-60 whitespace-normal p-0 text-left"
                    onClick={() => void navigate(`/tasks/automations/${schedule.id}`)}
                  >
                    {schedule.config?.name || t("automation.unnamed")}
                  </Button>
                </TableCell>
                <TableCell>{roleLabel(schedule.agent?.name ?? "")}</TableCell>
                <TableCell>
                  <Badge variant={schedule.config?.paused ? "outline" : "secondary"}>
                    {t(schedule.config?.paused ? "automation.paused" : "automation.active")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <p className="font-mono text-xs">{schedule.config?.schedule}</p>
                  <p className="text-xs text-muted-foreground">{schedule.config?.timeZone}</p>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {scheduledTime(schedule.nextExecutionTime, schedule.config?.timeZone)}
                </TableCell>
                {manage && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("automation.runNow")}
                        disabled={action.isPending}
                        onClick={() => action.mutate({ schedule, run: true })}
                      >
                        <Play />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t(
                          schedule.config?.paused ? "automation.resume" : "automation.pause",
                        )}
                        disabled={action.isPending}
                        onClick={() => action.mutate({ schedule, run: false })}
                      >
                        {schedule.config?.paused ? <Play /> : <Pause />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("automation.edit")}
                        onClick={() => setEditing({ schedule })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("automation.delete")}
                        onClick={() => setDeleting(schedule)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {list.isSuccess && !list.data.scheduledRuns.length && (
          <p className="text-sm text-muted-foreground">{t("automation.empty")}</p>
        )}
        {(page.page > 0 || next) && (
          <PageControl
            page={page.page}
            hasNext={!!next}
            onPage={page.onPage}
            label={t("automation.schedules")}
            disabled={list.isFetching}
          />
        )}
        <p className="text-xs text-muted-foreground">{t("automation.identityHint")}</p>
      </section>
      <EventTriggers />
      {editing && (
        <ResourceSheet
          open
          title={t(editing.schedule ? "automation.edit" : "automation.create")}
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
        >
          <ScheduleEditor
            schedule={editing.schedule}
            onSaved={() => {
              setEditing(undefined);
              void refresh();
            }}
          />
        </ResourceSheet>
      )}
      {scheduleId && (
        <ScheduleDetail
          key={scheduleId}
          id={scheduleId}
          onClose={() => void navigate("/tasks/automations")}
        />
      )}
      {deleting && (
        <ConfirmDelete
          title={t("automation.delete")}
          description={t("automation.deleteHint")}
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            await automationClient.deleteScheduledRun({ scheduledRunId: deleting.id });
            await refresh();
          }}
        />
      )}
    </div>
  );
}
