import { skipToken, useQuery } from "@connectrpc/connect-query";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { errorKey } from "../../lib/errors.js";
import { Approval } from "../shared/Approval.js";
import { engineerDescription, engineerName } from "../shared/engineers.js";
import { Markdown } from "../shared/Markdown.js";
import { active } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { CallList } from "./Calls.js";
import type { FlowActivity } from "./flow/collaboration-flow.js";

export interface DrawerTarget {
  activity?: FlowActivity;
  callKey?: string;
}

export function AgentDrawer({
  detail,
  target,
  open,
  onOpenChange,
}: {
  detail: TaskDetail;
  target: DrawerTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const taskId = target.callKey?.split(":")[0] ?? target.activity?.taskId ?? "";
  const review = target.activity?.kind === "review";
  const interaction = detail.interactions.find(
    (item) => item.id === target.activity?.interaction?.id,
  );
  const summary = detail.runs.find((run) => run.taskId === taskId);
  const agent = detail.participants.find(
    (item) => item.id === (summary?.agentId ?? target.activity?.agentId),
  );
  const inspectRun = !!(open && taskId && (!interaction || review));
  const run = useQuery(ConsoleService.method.getTaskRun, inspectRun ? { taskId } : skipToken, {
    retry: false,
  });
  const { refetch } = run;
  const revision = `${summary?.state}:${summary?.updatedAt?.seconds}:${summary?.updatedAt?.nanos}`;
  useEffect(() => {
    if (inspectRun && revision) void refetch();
  }, [inspectRun, revision, refetch]);
  const result = run.data?.run;
  const state = review ? summary?.state : (interaction?.state ?? summary?.state);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        showCloseButton={false}
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]"
        data-testid="agent-drawer"
      >
        <SheetHeader className="border-b px-5 py-5 pr-14">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {interaction && !review
              ? t(
                  interaction.kind === InteractionKind.APPROVAL
                    ? "approval.title"
                    : "approval.userInput",
                )
              : agent
                ? engineerName(agent)
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
            {interaction && !review ? (
              <Approval key={interaction.id} interaction={interaction} />
            ) : (
              <>
                {run.isPending && (
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
                {result?.prompt && !review && (
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">{t("task.prompt")}</h3>
                    <p
                      className="text-sm leading-6 whitespace-pre-wrap break-words"
                      data-testid="task-prompt"
                    >
                      {result.prompt}
                    </p>
                  </section>
                )}
                {review && interaction && <Approval interaction={interaction} />}
                {detail.interactions
                  .filter((item) => item.taskId === taskId && item.id !== interaction?.id)
                  .map((item) => (
                    <Approval key={item.id} interaction={item} />
                  ))}
                {result && (
                  <section>
                    <h3 className="mb-1 text-sm font-semibold">{t("tool.calls")}</h3>
                    <CallList
                      key={`${taskId}:${target.callKey}`}
                      calls={result.calls}
                      selected={target.callKey}
                    />
                  </section>
                )}
                {result?.output && !review && !active(result.state) && (
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
