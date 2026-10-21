import { Blocks, GitBranch, ListOrdered } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InteractionKind, type TaskDetail } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { active, awaiting } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { AgentDrawer, type DrawerTarget } from "./AgentDrawer.js";
import { BackgroundTasks } from "./BackgroundTasks.js";
import { Collaboration } from "./Collaboration.js";
import { currentInteraction } from "./flow/approval-activities.js";
import { collaborationFlow, type FlowActivity, instanceNodeId } from "./flow/collaboration-flow.js";
import type { ConnectionBundle } from "./flow/connection-bundles.js";
import { McpExecution } from "./McpExecution.js";
import { StopTask } from "./StopTask.js";
import { TaskConclusion } from "./TaskConclusion.js";
import { TaskTags } from "./TaskTags.js";
import { Timeline } from "./Timeline.js";

const concluded = (state: ActivityState) =>
  !active(state) && !awaiting(state) && state !== ActivityState.UNOBSERVED;

export function TaskView({
  detail,
  focusTaskId,
  openApproval,
  availableTags,
}: {
  detail: TaskDetail;
  focusTaskId: string;
  openApproval: boolean;
  availableTags: string[];
}) {
  const { t } = useTranslation();
  const focus =
    detail.summary?.id !== focusTaskId
      ? detail.runs.find((run) => run.taskId === focusTaskId)
      : undefined;
  const initialApproval = openApproval
    ? detail.interactions.find(
        (item) =>
          item.kind === InteractionKind.APPROVAL &&
          awaiting(item.state) &&
          !detail.runs.some((run) => run.taskId === item.taskId && run.background),
      )
    : undefined;
  const [target, setTarget] = useState<DrawerTarget>(() =>
    initialApproval
      ? { interactionId: initialApproval.id }
      : focus
        ? { taskId: focus.taskId, contextId: focus.contextId }
        : {},
  );
  const [open, setOpen] = useState(!!focus || !!initialApproval);
  const [view, setView] = useState("graph");
  const [toolTaskId, setToolTaskId] = useState(focusTaskId);
  const initialApprovalId = initialApproval?.id;
  useEffect(() => {
    if (initialApprovalId) {
      setTarget({ interactionId: initialApprovalId });
      setOpen(true);
    }
  }, [initialApprovalId]);
  const summary = detail.summary;
  const flow = useMemo(() => collaborationFlow(detail), [detail]);
  const collaborative = flow.activities.length > 1;
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
    <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex shrink-0 flex-col gap-2 px-1 pt-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <h2
          data-testid="task-title"
          title={summary?.prompt}
          className="line-clamp-2 min-w-0 text-lg leading-7 font-semibold tracking-tight sm:flex-1 sm:text-xl sm:leading-7"
        >
          {summary?.title || t("navigation.tasks")}
        </h2>
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
          {detail.runs.some(
            (run) => !run.background && (active(run.state) || awaiting(run.state)),
          ) &&
            summary && <StopTask taskId={summary.id} operate={detail.operate} />}
        </div>
      </div>
      {summary && <TaskTags task={summary} editable={detail.editTags} available={availableTags} />}
      <Tabs value={view} onValueChange={setView}>
        <TabsList aria-label={t("task.view")}>
          <TabsTrigger value="graph">
            {collaborative ? <GitBranch /> : <Blocks />}
            {t(collaborative ? "graph.title" : "graph.mcpCalls")}
          </TabsTrigger>
          {collaborative && (
            <TabsTrigger value="tools">
              <Blocks />
              {t("graph.mcpCalls")}
            </TabsTrigger>
          )}
          <TabsTrigger value="timeline">
            <ListOrdered />
            {t("task.timeline")}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {view === "timeline" ? (
        <Timeline
          detail={detail}
          onSelect={(next) => {
            setTarget(next);
            setOpen(true);
          }}
        />
      ) : view === "graph" && collaborative ? (
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
          onExplore={(activity) => {
            setToolTaskId(activity.taskId);
            setView("tools");
          }}
          onConnection={selectConnection}
        />
      ) : (
        <McpExecution
          key={toolTaskId}
          detail={detail}
          flow={flow}
          initialTaskId={toolTaskId}
          target={target}
          onInspect={(next) => {
            setTarget(next);
            setOpen(true);
          }}
        />
      )}
      {detail.answer && state !== ActivityState.CANCELED && concluded(state) && !pending.length && (
        <TaskConclusion answer={detail.answer} />
      )}
      <AgentDrawer detail={detail} flow={flow} target={target} open={open} onOpenChange={setOpen} />
    </div>
  );
}
