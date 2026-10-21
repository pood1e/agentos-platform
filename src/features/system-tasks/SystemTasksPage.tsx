import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Plus, ShieldCheck } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import type { ScheduledRun } from "../../../gen/kagent/api/v1alpha1/scheduled_runs_pb.js";
import { can, isAdministrator } from "../../../shared/permissions.js";
import { useAccess } from "../../lib/access.js";
import { automationClient } from "../../lib/console.js";
import { cn } from "../../lib/utils.js";
import { ConfirmDelete, ResourceSheet } from "../management/ResourceDialog.js";
import { Failure } from "../management/ResourcePage.js";
import { PageControl } from "../shared/PageControl.js";
import { usePaging } from "../shared/paging.js";
import { useTask } from "../tasks/use-task.js";
import { EventTriggers } from "./EventTriggers.js";
import { ScheduleCard } from "./ScheduleCard.js";
import { ScheduleDetail } from "./ScheduleDetail.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { SystemExecutions } from "./SystemExecutions.js";

const TaskPanel = lazy(() =>
  import("../tasks/TaskPanel.js").then((module) => ({ default: module.TaskPanel })),
);

export function SystemTasksPage() {
  const { t } = useTranslation();
  const { scheduleId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const access = useAccess();
  const manage = can(access.data, Capability.TASKS_MANAGE);
  const allowed = isAdministrator(access.data);
  const selected = search.get("task") ?? "";
  const task = useTask(allowed ? selected : "");
  const query = useQueryClient();
  const paging = usePaging();
  const [editing, setEditing] = useState<{ schedule?: ScheduledRun }>();
  const [deleting, setDeleting] = useState<ScheduledRun>();
  const [manualIds] = useState(() => new Map<string, string>());
  const list = useQuery({
    enabled: allowed,
    queryKey: ["system-tasks", "list", paging.pageToken],
    queryFn: ({ signal }) =>
      automationClient.listScheduledRuns(
        {
          page: { limit: paging.pageSize, pageToken: paging.pageToken },
        },
        { signal },
      ),
    refetchInterval: 5_000,
  });
  const refresh = () => query.invalidateQueries({ queryKey: ["system-tasks"] });
  const action = useMutation({
    mutationFn: async ({ schedule, run }: { schedule: ScheduledRun; run: boolean }) => {
      if (run) {
        const requestId = manualIds.get(schedule.id) ?? crypto.randomUUID();
        manualIds.set(schedule.id, requestId);
        await automationClient.triggerScheduledRun({ scheduledRunId: schedule.id, requestId });
        manualIds.delete(schedule.id);
        void navigate(`/system-tasks/${schedule.id}`);
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
  const selectTask = (id: string) => {
    const next = new URLSearchParams(search);
    if (id) next.set("task", id);
    else next.delete("task");
    next.delete("approval");
    setSearch(next, { replace: !id });
  };
  if (!access.data) return null;
  if (!allowed) return <Navigate to="/chat" replace />;
  return (
    <div data-testid="system-task-workspace" className="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">{t("automation.title")}</h1>
      <div
        className={cn(
          "grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-5",
          selected && "xl:grid-cols-2",
        )}
      >
        <div
          className={cn(
            "min-h-0 min-w-0 space-y-7 overflow-y-auto px-px pb-2",
            selected && "hidden xl:block",
          )}
        >
          <section className="space-y-4" aria-label={t("automation.schedules")}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-base font-semibold">{t("automation.schedules")}</h2>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="gap-1.5 font-normal text-muted-foreground"
                      tabIndex={0}
                    >
                      <ShieldCheck className="size-3" />
                      {t("automation.readOnlyIdentity")}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">
                    {t("automation.identityHint")}
                  </TooltipContent>
                </Tooltip>
              </div>
              {manage && (
                <Button onClick={() => setEditing({})}>
                  <Plus />
                  {t("automation.create")}
                </Button>
              )}
            </div>
            <Failure error={list.error || action.error} />
            {list.isPending && (
              <div
                role="status"
                className={cn("grid gap-4", !selected && "xl:grid-cols-2")}
                aria-label={t("automation.loading")}
              >
                <Skeleton className="h-64 rounded-xl" />
                <Skeleton className="h-64 rounded-xl" />
              </div>
            )}
            <div className={cn("grid gap-4", !selected && "xl:grid-cols-2")}>
              {list.data?.scheduledRuns.map((schedule) => (
                <ScheduleCard
                  key={schedule.id}
                  schedule={schedule}
                  manage={manage}
                  pending={action.isPending}
                  onOpen={() => void navigate(`/system-tasks/${schedule.id}`)}
                  onRun={() => action.mutate({ schedule, run: true })}
                  onToggle={() => action.mutate({ schedule, run: false })}
                  onEdit={() => setEditing({ schedule })}
                  onDelete={() => setDeleting(schedule)}
                />
              ))}
            </div>
            {list.isSuccess && !list.data.scheduledRuns.length && (
              <Card className="items-center gap-3 border-dashed px-5 py-12 text-center text-muted-foreground">
                <Clock3 className="size-7" />
                <p className="text-sm">{t("automation.empty")}</p>
                {manage && (
                  <Button variant="outline" onClick={() => setEditing({})}>
                    <Plus />
                    {t("automation.create")}
                  </Button>
                )}
              </Card>
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
          </section>
          <EventTriggers />
          <SystemExecutions />
        </div>
        {selected && (
          <Suspense fallback={null}>
            <TaskPanel
              taskId={selected}
              detail={task.value}
              error={task.error}
              tasks={task.value?.summary ? [task.value.summary] : []}
              openApproval={search.get("approval") === "1"}
              onSelect={selectTask}
              onClose={() => selectTask("")}
            />
          </Suspense>
        )}
      </div>
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
          onClose={() => void navigate("/system-tasks")}
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
