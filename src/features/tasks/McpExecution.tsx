import { skipToken, useQuery } from "@connectrpc/connect-query";
import { ArrowUpRight, Blocks, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { TaskDetail } from "../../../gen/agentos/console/v1/task_pb.js";
import { Failure } from "../management/ResourcePage.js";
import type { DrawerTarget } from "./AgentDrawer.js";
import { type CollaborationFlow, instanceNodeId } from "./flow/collaboration-flow.js";
import { instanceNames } from "./flow/instance-names.js";

const McpGraph = lazy(() =>
  import("./McpGraph.js").then((module) => ({ default: module.McpGraph })),
);

export function McpExecution({
  detail,
  flow,
  initialTaskId,
  target,
  onInspect,
}: {
  detail: TaskDetail;
  flow: CollaborationFlow;
  initialTaskId: string;
  target: DrawerTarget;
  onInspect: (target: DrawerTarget) => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState(initialTaskId);
  const execution =
    detail.runs.find((run) => run.taskId === chosen) ??
    detail.runs.find((run) => run.taskId === detail.summary?.id) ??
    detail.runs[0];
  const taskId = execution?.taskId;
  const run = useQuery(ConsoleService.method.getTaskRun, taskId ? { taskId } : skipToken, {
    retry: false,
  });
  const { refetch } = run;
  const revision = `${execution?.state}:${execution?.updatedAt?.seconds}:${execution?.updatedAt?.nanos}`;
  useEffect(() => {
    if (taskId && revision) void refetch();
  }, [taskId, revision, refetch]);
  const names = instanceNames(flow.activities, detail.participants);
  const loading = (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" />
      {t("drawer.loading")}
    </div>
  );
  return (
    <section
      className="flex min-h-[28rem] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border sm:min-h-64"
      data-testid="mcp-execution-graph"
      aria-label={t("graph.mcpCalls")}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-card px-3 py-2">
        {detail.runs.length > 1 ? (
          <Select value={taskId} onValueChange={setChosen}>
            <SelectTrigger
              className="h-8 max-w-full sm:max-w-72"
              aria-label={t("graph.selectExecution")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {detail.runs.map((item, index) => (
                <SelectItem key={item.taskId} value={item.taskId}>
                  {names.get(instanceNodeId(item.contextId))} ·{" "}
                  {t("drawer.executionNumber", { number: index + 1 })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Blocks className="size-3.5" />
            {t("graph.mcpTopology")}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          data-testid="task-engineer"
          onClick={() => onInspect({ taskId, contextId: execution?.contextId })}
          disabled={!taskId}
        >
          {t("graph.executionDetails")}
          <ArrowUpRight />
        </Button>
      </div>
      <Failure error={run.error} />
      {run.isPending ? (
        loading
      ) : run.data?.run ? (
        <Suspense fallback={loading}>
          <McpGraph
            run={run.data.run}
            engineer={detail.participants.find((item) => item.id === execution?.agentId)}
            selected={target.taskId === taskId ? target.mcpServer : undefined}
            onInspect={onInspect}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
