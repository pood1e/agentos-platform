import {
  Bot,
  Clock3,
  History,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Power,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ScheduledRun } from "../../../gen/kagent/api/v1/scheduled_runs_pb.js";
import { roleLabel } from "../shared/engineers.js";
import { scheduledTime } from "./format.js";
import { ScheduleStatus } from "./ScheduleStatus.js";

export function ScheduleCard({
  schedule,
  manage,
  deletable,
  pending,
  onOpen,
  onRun,
  onToggle,
  onEdit,
  onDelete,
}: {
  schedule: ScheduledRun;
  manage: boolean;
  deletable: boolean;
  pending: boolean;
  onOpen: () => void;
  onRun: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const config = schedule.config;
  return (
    <Card className="min-w-0 gap-0 py-0" data-testid="scheduled-run-row">
      <CardContent className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Clock3 className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <Button
              variant="link"
              className="h-auto max-w-full whitespace-normal p-0 text-left text-base font-semibold text-foreground"
              onClick={onOpen}
            >
              {config?.name || t("automation.unnamed")}
            </Button>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Bot className="size-3.5 shrink-0" />
              {roleLabel(schedule.agent?.name ?? "")}
            </p>
          </div>
          <ScheduleStatus paused={config?.paused} />
          {manage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t("automation.moreActions")}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onEdit}>
                  <Pencil />
                  {t("automation.edit")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onOpen}>
                  <History />
                  {t("automation.history")}
                </DropdownMenuItem>
                {deletable && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                      <Trash2 />
                      {t("automation.delete")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <p
          className="line-clamp-2 min-h-10 break-words text-sm leading-5 text-muted-foreground"
          title={config?.prompt}
        >
          {config?.prompt}
        </p>
        <dl className="mt-auto grid grid-cols-2 gap-4 rounded-lg bg-muted/45 p-3 text-xs">
          <div className="min-w-0 space-y-1.5">
            <dt className="text-muted-foreground">{t("automation.cadence")}</dt>
            <dd className="break-words font-mono text-sm">{config?.schedule}</dd>
            <dd className="break-words text-muted-foreground">{config?.timeZone}</dd>
          </div>
          <div className="min-w-0 space-y-1.5 border-l pl-4">
            <dt className="text-muted-foreground">{t("automation.nextExecution")}</dt>
            <dd className="break-words leading-5">
              {config?.paused
                ? t("automation.waitingToEnable")
                : scheduledTime(schedule.nextExecutionTime, config?.timeZone)}
            </dd>
          </div>
        </dl>
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 bg-transparent px-4 py-3">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onOpen}>
          <History />
          {t("automation.history")}
        </Button>
        {manage && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={pending} onClick={onToggle}>
              {config?.paused ? <Power /> : <Pause />}
              {t(config?.paused ? "automation.resume" : "automation.pause")}
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={onRun}>
              <Play />
              {t("automation.runNow")}
            </Button>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}
