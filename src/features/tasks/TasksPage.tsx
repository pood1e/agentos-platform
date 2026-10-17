import { useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import { InteractionKind, type TaskDetail } from "../../../gen/agentos/console/v1/task_pb.js";
import { consoleClient } from "../../lib/console.js";
import { useWatch } from "../../lib/use-watch.js";
import { Avatar } from "../shared/Avatar.js";
import { engineerName } from "../shared/engineers.js";
import { usePaging } from "../shared/paging.js";
import { active, awaiting, posture } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { AgentDrawer, type DrawerTarget } from "./AgentDrawer.js";
import { BackgroundTasks } from "./BackgroundTasks.js";
import { Collaboration } from "./Collaboration.js";
import { currentInteraction } from "./flow/approval-activities.js";
import { collaborationFlow, type FlowActivity, instanceNodeId } from "./flow/collaboration-flow.js";
import type { ConnectionBundle } from "./flow/connection-bundles.js";
import { TaskConclusion } from "./TaskConclusion.js";
import { TaskList } from "./TaskList.js";

async function* follow(taskId: string, signal: AbortSignal) {
  for await (const { task } of consoleClient.watchTask({ taskId }, { signal }))
    if (task) yield task;
}

const concluded = (state: ActivityState) =>
  !active(state) && !awaiting(state) && state !== ActivityState.UNOBSERVED;

function TaskView({ detail, focusTaskId }: { detail: TaskDetail; focusTaskId: string }) {
  const { t } = useTranslation();
  const focus =
    detail.summary?.id !== focusTaskId
      ? detail.runs.find((run) => run.taskId === focusTaskId)
      : undefined;
  const [target, setTarget] = useState<DrawerTarget>(() =>
    focus ? { taskId: focus.taskId, contextId: focus.contextId } : {},
  );
  const [open, setOpen] = useState(!!focus);
  const summary = detail.summary;
  const flow = useMemo(() => collaborationFlow(detail), [detail]);
  const collaborative = flow.activities.length > 1;
  const single = !collaborative ? flow.activities[0] : undefined;
  const engineer = detail.participants.find((item) => item.id === single?.agentId);
  const background = new Set(detail.runs.filter((run) => run.background).map((run) => run.taskId));
  const pending = detail.interactions.filter(
    (item) => awaiting(item.state) && !background.has(item.taskId),
  );
  const review = pending.find((item) => item.kind === InteractionKind.APPROVAL) ?? pending[0];
  const select = useCallback((activity: FlowActivity) => {
    setTarget(
      activity.kind === "approval"
        ? { activityId: activity.id, interactionId: currentInteraction(activity.interactions)?.id }
        : { contextId: activity.contextId },
    );
    setOpen(true);
  }, []);
  const selectConnection = useCallback((connection: ConnectionBundle) => {
    setTarget({ connectionId: connection.id });
    setOpen(true);
  }, []);
  const state = summary?.state ?? ActivityState.UNSPECIFIED;
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-2 px-1 pt-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <h1
          data-testid="task-title"
          title={summary?.prompt}
          className="line-clamp-2 min-w-0 text-lg leading-7 font-semibold tracking-tight sm:flex-1 sm:text-2xl sm:leading-8"
        >
          {summary?.title || t("navigation.tasks")}
        </h1>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <Status
            state={state}
            onClick={
              review
                ? () => {
                    setTarget({ interactionId: review.id });
                    setOpen(true);
                  }
                : undefined
            }
          />
          <BackgroundTasks
            runs={detail.runs}
            onSelect={(run) => {
              setTarget({ taskId: run.taskId, contextId: run.contextId });
              setOpen(true);
            }}
          />
        </div>
      </div>
      {collaborative ? (
        <Collaboration
          participants={detail.participants}
          flow={flow}
          selected={
            target.interactionId
              ? (flow.activities.find((activity) =>
                  activity.interactions.some((item) => item.id === target.interactionId),
                )?.id ?? "")
              : (target.activityId ?? (target.contextId ? instanceNodeId(target.contextId) : ""))
          }
          selectedConnection={target.connectionId ?? ""}
          onSelect={select}
          onConnection={selectConnection}
        />
      ) : (
        single &&
        engineer && (
          <Button
            variant="ghost"
            className="h-auto w-fit max-w-full shrink-0 gap-2 px-2 py-1"
            data-testid="task-engineer"
            aria-label={t("task.executionDetails", { name: engineerName(engineer) })}
            onClick={() => select(single)}
          >
            <Avatar role={engineer.role} state={posture(state)} className="h-9 w-7" />
            <span className="truncate text-sm">{engineerName(engineer)}</span>
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </Button>
        )
      )}
      {detail.answer && concluded(state) && !pending.length && (
        <TaskConclusion answer={detail.answer} collaborative={collaborative} />
      )}
      <AgentDrawer detail={detail} flow={flow} target={target} open={open} onOpenChange={setOpen} />
    </div>
  );
}

export function TasksPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { taskId = "" } = useParams();
  const paging = usePaging();
  const list = useQuery(
    ConsoleService.method.listTasks,
    { pageToken: paging.pageToken, pageSize: paging.pageSize, query: paging.query },
    { refetchInterval: 3_000, placeholderData: keepPreviousData },
  );
  const selected = taskId || list.data?.tasks[0]?.id || "";
  useEffect(() => {
    if (!taskId && selected) void navigate(`/tasks/${selected}`, { replace: true });
  }, [taskId, selected, navigate]);
  const { value: detail, error } = useWatch(selected || undefined, (signal) =>
    follow(selected, signal),
  );
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 lg:grid-cols-[200px_minmax(0,1fr)] lg:grid-rows-1 lg:gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
      <TaskList
        tasks={list.data?.tasks ?? []}
        total={list.data?.totalSize ?? 0}
        paging={paging.controls(list.data?.nextPageToken)}
        selectedId={detail?.summary?.id ?? selected}
        selectedTitle={detail?.summary?.title}
        onSelect={(id) => navigate(`/tasks/${id}`)}
      />
      {detail ? (
        <TaskView
          key={`${detail.summary?.id}:${selected}`}
          detail={detail}
          focusTaskId={selected}
        />
      ) : (
        <p className="flex items-center justify-center text-sm text-muted-foreground">
          {t(error || (list.data && !selected ? "task.noTasks" : "status.connecting"))}
        </p>
      )}
    </div>
  );
}
