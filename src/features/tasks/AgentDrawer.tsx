import { skipToken, useQuery } from "@connectrpc/connect-query";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { InteractionKind, type TaskDetail } from "../../../gen/agentos/console/v1/task_pb.js";
import { errorKey } from "../../../shared/errors.js";
import { millis, time } from "../../lib/format.js";
import { Approval } from "../shared/Approval.js";
import { engineerDescription, engineerName } from "../shared/engineers.js";
import { Markdown } from "../shared/Markdown.js";
import { useToolText } from "../shared/use-tool-text.js";
import { active, awaiting, labelKey } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { CallList } from "./Calls.js";
import { currentInteraction } from "./flow/approval-activities.js";
import { type CollaborationFlow, instanceNodeId } from "./flow/collaboration-flow.js";
import { bundleConnections, connectionSteps, currentStep } from "./flow/connection-bundles.js";
import { instanceNames } from "./flow/instance-names.js";
import { TaskContent } from "./TaskContent.js";

export interface DrawerTarget {
  activityId?: string;
  connectionId?: string;
  contextId?: string;
  taskId?: string;
  interactionId?: string;
  callKey?: string;
  mcpServer?: string;
}

export function AgentDrawer({
  detail,
  flow,
  target,
  open,
  onOpenChange,
}: {
  detail: TaskDetail;
  flow: CollaborationFlow;
  target: DrawerTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const toolText = useToolText();
  const [selection, setSelection] = useState<{ target: DrawerTarget; value: string }>();
  const chosen = selection?.target === target ? selection.value : "";
  const connection = bundleConnections(flow.connections).find(
    (item) => item.id === target.connectionId,
  );
  const rounds = connection ? connectionSteps(connection) : [];
  const round = rounds.find(({ link }) => link.id === chosen) ?? currentStep(rounds);
  const activity = target.activityId
    ? (flow.activities.find((item) => item.id === target.activityId) ??
      flow.activities.find((item) =>
        item.interactions.some((approval) => approval.id === target.interactionId),
      ))
    : undefined;
  const approvals = activity?.interactions ?? [];
  const approval = approvals.find((item) => item.id === chosen) ?? currentInteraction(approvals);
  const link = round?.link;
  const inspected: DrawerTarget = approval
    ? { interactionId: approval.id }
    : link
      ? link.kind === "approval"
        ? { interactionId: link.id }
        : link.callKey
          ? { taskId: link.sourceTaskId, contextId: link.sourceContextId, callKey: link.callKey }
          : { taskId: link.targetTaskId, contextId: link.targetContextId }
      : target;
  const executions = detail.runs
    .filter((run) => run.contextId === inspected.contextId)
    .sort((a, b) => (millis(a.updatedAt) ?? 0) - (millis(b.updatedAt) ?? 0));
  const choices =
    round || inspected.callKey
      ? []
      : executions.map((run, index) => ({
          id: run.taskId,
          taskId: run.taskId,
          label: `${t("drawer.executionNumber", { number: index + 1 })} · ${time(millis(run.updatedAt))} · ${t(labelKey(run.state))}`,
        }));
  const current =
    executions.findLast((run) => active(run.state)) ??
    executions.findLast((run) => awaiting(run.state)) ??
    executions.at(-1);
  const choice =
    choices.find((item) => item.id === chosen) ??
    choices.find((item) => item.id === (inspected.taskId ?? current?.taskId)) ??
    choices.at(-1);
  const selectedCall = inspected.callKey;
  const taskId = choice?.taskId ?? inspected.callKey?.split(":")[0] ?? inspected.taskId ?? "";
  const interaction = detail.interactions.find((item) => item.id === inspected.interactionId);
  const summary = detail.runs.find((run) => run.taskId === taskId);
  const agent = detail.participants.find(
    (item) =>
      item.id ===
      (summary?.agentId ??
        flow.activities.find((item) => item.contextId === inspected.contextId)?.agentId ??
        interaction?.agentId),
  );
  const names = instanceNames(flow.activities, detail.participants);
  const title = names.get(instanceNodeId(summary?.contextId ?? inspected.contextId ?? ""));
  const options = connection
    ? rounds.map((step, index) => {
        const from = names.get(instanceNodeId(step.link.sourceContextId)) ?? "";
        const to =
          step.link.kind === "approval"
            ? t("approval.title")
            : (names.get(instanceNodeId(step.link.targetContextId)) ?? "");
        return {
          id: step.link.id,
          label: `${t("drawer.roundNumber", { number: step.order ?? index + 1 })} · ${from} → ${to} · ${t(labelKey(step.link.state))}`,
        };
      })
    : activity
      ? approvals.map((item, index) => ({
          id: item.id,
          label: `${t("drawer.roundNumber", { number: index + 1 })} · ${time(millis(item.requestedAt))} · ${t(labelKey(item.state))}`,
        }))
      : choices;
  const inspectRun = !!(open && taskId && !interaction);
  const run = useQuery(ConsoleService.method.getTaskRun, inspectRun ? { taskId } : skipToken, {
    retry: false,
  });
  const { refetch } = run;
  const revision = `${summary?.state}:${summary?.updatedAt?.seconds}:${summary?.updatedAt?.nanos}`;
  useEffect(() => {
    if (inspectRun && revision) void refetch();
  }, [inspectRun, revision, refetch]);
  const result = run.data?.run;
  const state =
    interaction?.state ??
    summary?.state ??
    flow.activities.find((item) => item.contextId === inspected.contextId)?.state;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        showCloseButton={false}
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
        data-testid="agent-drawer"
      >
        <SheetHeader className="border-b px-5 py-5 pr-14">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {activity?.record
              ? (activity.record.link?.name ?? t("approval.title"))
              : interaction
                ? t(
                    interaction.kind === InteractionKind.APPROVAL
                      ? "approval.title"
                      : "approval.userInput",
                  )
                : agent
                  ? title || engineerName(agent)
                  : t("drawer.title")}
            {state !== undefined && <Status state={state} />}
          </SheetTitle>
          <SheetDescription className="text-xs leading-5">
            {agent ? engineerDescription(agent) : t("drawer.title")}
          </SheetDescription>
          <SheetClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("drawer.close")}
              className="absolute top-4 right-4"
            >
              <X />
            </Button>
          </SheetClose>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 p-5">
            {options.length > 1 && (
              <Select
                value={link?.id ?? approval?.id ?? choice?.id}
                onValueChange={(value) => setSelection({ target, value })}
              >
                <SelectTrigger
                  aria-label={t(
                    connection
                      ? "drawer.rounds"
                      : activity
                        ? "drawer.approvals"
                        : "drawer.execution",
                  )}
                  className="w-full"
                  data-testid={
                    connection ? "round-picker" : activity ? "approval-picker" : "execution-picker"
                  }
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {interaction ? (
              <Approval
                key={interaction.id}
                interaction={interaction}
                record={activity?.record}
                operate={detail.operate}
              />
            ) : (
              <>
                {!taskId && (
                  <p className="text-sm text-muted-foreground">{t("drawer.waitingExecution")}</p>
                )}
                {inspectRun && run.isPending && (
                  <div
                    role="status"
                    className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
                  >
                    <LoaderCircle className="size-4 animate-spin" />
                    {t("drawer.loading")}
                  </div>
                )}
                {run.isError && (
                  <Alert variant="destructive">
                    <AlertDescription className="flex items-center justify-between gap-3">
                      {t(errorKey(run.error, "drawer.unavailable"))}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={run.isFetching}
                        onClick={() => void refetch()}
                      >
                        <RefreshCw className={run.isFetching ? "animate-spin" : undefined} />
                        {t("drawer.retry")}
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                {result?.prompt && (
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">{t("task.prompt")}</h3>
                    <TaskContent key={taskId} content={result.prompt} />
                  </section>
                )}
                {detail.interactions
                  .filter(
                    (item) =>
                      (item.taskId === taskId ||
                        detail.delegations.some(
                          (link) =>
                            link.targetTaskId === taskId && link.requestId === item.requestId,
                        )) &&
                      item.id !== inspected.interactionId,
                  )
                  .map((item) => (
                    <Approval key={item.id} interaction={item} operate={detail.operate} />
                  ))}
                {result && (
                  <section>
                    <h3 className="mb-1 text-sm font-semibold">{t("tool.calls")}</h3>
                    <CallList
                      key={`${taskId}:${selectedCall}`}
                      calls={
                        inspected.mcpServer
                          ? result.calls.filter(
                              (call) => toolText(call.name).server === inspected.mcpServer,
                            )
                          : result.calls
                      }
                      selected={selectedCall}
                    />
                  </section>
                )}
                {result?.output && !active(result.state) && (
                  <section className="space-y-3 border-t pt-5">
                    <h3 className="text-sm font-semibold">{t("drawer.result")}</h3>
                    <Markdown>{result.output}</Markdown>
                  </section>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
