import { create } from "@bufbuild/protobuf";
import { ArrowUpRight, ChevronDown, LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Interaction } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import type { Approval } from "../../../gen/agentos/governance/v1/governance_pb.js";
import { AppReferenceSchema } from "../../../gen/agentos/mcp/v1/app_pb.js";
import { Failure } from "../management/ResourcePage.js";
import { awaiting, labelKey } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { approvalIdentity } from "./approval-identity.js";
import { Markdown } from "./Markdown.js";
import type { useExternalApprovals } from "./use-external-approvals.js";

const AppView = lazy(() =>
  import("../chat/apps/AppView.js").then((module) => ({ default: module.AppView })),
);

export function ExternalApprovals({
  interaction,
  record,
  result,
}: {
  interaction: Interaction;
  record?: Approval;
  result: ReturnType<typeof useExternalApprovals>;
}) {
  const { t } = useTranslation();
  const pending = awaiting(interaction.state);
  const approvals = [
    ...new Map(
      (result.data?.approvals ?? interaction.approvals)
        .filter((item) => !record || approvalIdentity(item) === approvalIdentity(record))
        .map((item) => [approvalIdentity(item), item]),
    ).values(),
  ];
  return (
    <div className="space-y-2" data-testid="external-approvals">
      <Failure error={result.error} />
      {pending && !approvals.length && !result.error && (
        <LoaderCircle className="size-4 animate-spin" />
      )}
      {pending && (
        <p className="text-muted-foreground">
          {t(
            approvals.some((item) => item.app) ? "approval.appNotice" : "approval.operationNotice",
          )}
        </p>
      )}
      {approvals.map((approval) => (
        <Collapsible
          key={approvalIdentity(approval)}
          defaultOpen
          className="group/approval rounded-lg border px-3 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left text-xs">
              <span className="truncate">{approval.link?.name || t("approval.title")}</span>
              <Status state={approval.state}>
                {t(
                  approval.state === ActivityState.FAILED &&
                    interaction.state === ActivityState.FAILED
                    ? "approval.validationFailed"
                    : labelKey(approval.state),
                )}
              </Status>
              {approval.decidedBy && (
                <span className="text-muted-foreground">{approval.decidedBy}</span>
              )}
              <ChevronDown className="ml-auto size-4 shrink-0 group-data-[state=open]/approval:rotate-180" />
            </CollapsibleTrigger>
            {approval.link && (
              <Button variant="link" size="sm" className="ml-auto h-auto p-0 text-xs" asChild>
                <a href={approval.link.url} target="_blank" rel="noreferrer">
                  <ArrowUpRight className="size-3" />
                  <span className="sr-only">{approval.link.name}</span>
                </a>
              </Button>
            )}
          </div>
          <CollapsibleContent forceMount className="space-y-3 pb-3 data-[state=closed]:hidden">
            {approval.reason && <p>{approval.reason}</p>}
            {approval.app && approval.reference ? (
              <Suspense fallback={<div className="h-48 animate-pulse bg-muted" />}>
                <AppView
                  reference={create(AppReferenceSchema, {
                    taskId: approval.reference.taskId,
                    origin: { case: "approvalToolId", value: approval.reference.toolId },
                  })}
                  input={approval.app}
                />
              </Suspense>
            ) : approval.description ? (
              <Markdown>{approval.description}</Markdown>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}
