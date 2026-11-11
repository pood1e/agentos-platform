import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useMutation, useQuery } from "@connectrpc/connect-query";
import { History, Pause, Play, Zap } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { ScheduleTemplate } from "../../../gen/agentos/console/v1/pack_pb.js";
import type { ScheduledRun } from "../../../gen/kagent/api/v1/scheduled_runs_pb.js";
import { usePack } from "../../lib/pack.js";
import { agentName } from "../shared/agents.js";
import { ConfirmDelete } from "../shared/ConfirmDelete.js";
import { ResourceSheet } from "../shared/ResourceDialog.js";
import { Failure, ResourcePage } from "../shared/ResourcePage.js";
import { RowActions } from "../shared/RowActions.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { ScheduleExecutions } from "./ScheduleExecutions.js";
import { agentId, enabled, toggled } from "./schedule-draft.js";

/** The caller's native schedules in this workspace and the solution's recommended ones. */
export function SchedulesPage() {
  const { t, i18n } = useTranslation();
  const pack = usePack();
  const list = useQuery(ConsoleService.method.listScheduledRuns, { page: { limit: 100 } });
  const agents = useQuery(ConsoleService.method.listAgents, {});
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ run?: ScheduledRun; template?: ScheduleTemplate }>();
  const [history, setHistory] = useState<ScheduledRun>();
  const [deleting, setDeleting] = useState<ScheduledRun>();
  const refresh = () => void list.refetch();
  const trigger = useMutation(ConsoleService.method.triggerScheduledRun, { onSuccess: refresh });
  const update = useMutation(ConsoleService.method.updateScheduledRun, { onSuccess: refresh });
  const remove = useMutation(ConsoleService.method.deleteScheduledRun, { onSuccess: refresh });
  const runs = list.data?.scheduledRuns ?? [];
  const templates = pack.schedules.filter((template) => !enabled(template, runs));
  const label = (run: { agent?: ScheduledRun["agent"] }) => {
    const agent = agents.data?.agents.find((item) => item.id === agentId(run.agent));
    return agent ? agentName(agent) : (run.agent?.name ?? "");
  };
  const needle = query.trim().toLowerCase();
  const visible = runs.filter((run) =>
    [run.config?.name, label(run), run.config?.prompt].some((text) =>
      text?.toLowerCase().includes(needle),
    ),
  );
  const time = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "short",
    timeStyle: "short",
  });
  const title = t("schedule.title");
  return (
    <>
      <ResourcePage
        title={title}
        query={query}
        onQuery={setQuery}
        total={visible.length}
        pending={list.isPending}
        fetching={list.isFetching}
        error={list.error}
        onRefresh={refresh}
        onAdd={() => setEditing({})}
        page={0}
        onPage={() => {}}
        pagination={false}
      >
        <Failure error={trigger.error ?? update.error} />
        {templates.length > 0 && (
          <div className="space-y-2 border-b p-4">
            <h2 className="text-sm font-medium">{t("schedule.templates")}</h2>
            {templates.map((template) => (
              <div key={template.config?.name} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {template.config?.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {label(template)} · <code>{template.config?.schedule}</code>
                  </span>
                </span>
                <Button size="sm" variant="outline" onClick={() => setEditing({ template })}>
                  {t("schedule.enable")}
                </Button>
              </div>
            ))}
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("schedule.name")}</TableHead>
              <TableHead>{t("schedule.agent")}</TableHead>
              <TableHead>{t("schedule.schedule")}</TableHead>
              <TableHead>{t("schedule.nextRun")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("management.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((run) => {
              const config = run.config;
              return (
                <TableRow key={run.id}>
                  <TableCell className="max-w-0 w-full truncate">
                    <Button
                      variant="link"
                      className="h-auto p-0 text-foreground"
                      onClick={() => setEditing({ run })}
                    >
                      {config?.name || run.id}
                    </Button>
                    <p className="truncate text-xs text-muted-foreground">{config?.prompt}</p>
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-xs">{label(run)}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    <code>{config?.schedule}</code>
                    <span className="ml-1 text-muted-foreground">{config?.timeZone || "UTC"}</span>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {config?.paused
                      ? t("schedule.pausedState")
                      : run.nextExecutionTime && time.format(timestampDate(run.nextExecutionTime))}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("schedule.runNow")}
                      disabled={trigger.isPending}
                      onClick={() =>
                        trigger.mutate({ scheduledRunId: run.id, requestId: crypto.randomUUID() })
                      }
                    >
                      <Zap />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t(config?.paused ? "schedule.resume" : "schedule.pause")}
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({
                          scheduledRunId: run.id,
                          etag: run.etag,
                          config: toggled(config),
                        })
                      }
                    >
                      {config?.paused ? <Play /> : <Pause />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("schedule.history")}
                      onClick={() => setHistory(run)}
                    >
                      <History />
                    </Button>
                    <RowActions
                      editable
                      onOpen={() => setEditing({ run })}
                      onDelete={() => setDeleting(run)}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ResourcePage>
      <ResourceSheet
        title={t(editing?.run ? "schedule.edit" : "schedule.add")}
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        {editing && (
          <ScheduleEditor
            key={editing.run?.id ?? editing.template?.config?.name ?? "new"}
            run={editing.run}
            template={editing.template}
            onSaved={() => {
              setEditing(undefined);
              refresh();
            }}
          />
        )}
      </ResourceSheet>
      <ResourceSheet
        title={`${t("schedule.history")} · ${history?.config?.name ?? ""}`}
        open={!!history}
        onOpenChange={(open) => {
          if (!open) setHistory(undefined);
        }}
      >
        {history && <ScheduleExecutions run={history} />}
      </ResourceSheet>
      {deleting && (
        <ConfirmDelete
          title={t("schedule.deleteTitle", { name: deleting.config?.name })}
          description={t("schedule.deleteNotice")}
          onConfirm={() => remove.mutateAsync({ scheduledRunId: deleting.id })}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </>
  );
}
