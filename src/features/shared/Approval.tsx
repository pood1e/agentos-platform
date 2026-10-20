import { useMutation } from "@connectrpc/connect-query";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { type Interaction, InteractionKind } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import type { Approval as ApprovalRecord } from "../../../gen/agentos/governance/v1/governance_pb.js";
import { useAccess } from "../../lib/access.js";
import { errorKey } from "../../lib/errors.js";
import { pretty } from "../../lib/format.js";
import { awaiting } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { ExternalApprovals } from "./ExternalApprovals.js";
import { Markdown } from "./Markdown.js";
import { ToolIcon } from "./ToolIcon.js";
import { useToolText } from "./use-tool-text.js";

function decisionLabel(interaction: Interaction) {
  const approval = interaction.kind === InteractionKind.APPROVAL;
  if (awaiting(interaction.state)) return approval ? "approval.pending" : "activity.awaitingInput";
  if (!approval) return "approval.answered";
  return interaction.state === ActivityState.REJECTED ? "approval.rejected" : "approval.approved";
}

export function Approval({
  interaction,
  record,
}: {
  interaction: Interaction;
  record?: ApprovalRecord;
}) {
  const { t } = useTranslation();
  const access = useAccess();
  const toolText = useToolText();
  const [answers, setAnswers] = useState<string[][]>(interaction.questions.map(() => []));
  const respond = useMutation(ConsoleService.method.respondInteraction);
  const pending = awaiting(interaction.state);
  const approval = interaction.kind === InteractionKind.APPROVAL;
  const locked = !access.data?.operate || !pending || respond.isPending || respond.isSuccess;
  const recorded = (index: number) => interaction.answers[index]?.values ?? [];
  const submit = (decision: Parameters<typeof respond.mutate>[0]["decision"]) =>
    respond.mutate({ taskId: interaction.taskId, requestId: interaction.requestId, decision });
  return (
    <section className="space-y-4" data-testid="approval-detail">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-warning" />
        <h3 className="text-sm font-semibold">
          {t(approval ? "approval.title" : "approval.userInput")}
        </h3>
        <Status state={interaction.state}>{t(decisionLabel(interaction))}</Status>
      </div>
      {interaction.explanation && <Markdown>{interaction.explanation}</Markdown>}
      {approval ? (
        <>
          {pending && interaction.external && (
            <p className="text-xs text-muted-foreground">{t("approval.operationNotice")}</p>
          )}
          {interaction.tools.map((tool) => {
            const label = toolText(tool.name);
            return (
              <div key={tool.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <ToolIcon name={tool.name} server={label.server} className="size-7" />
                  <strong className="text-xs">{label.name}</strong>
                  <code
                    data-testid="approval-tool"
                    className="break-all text-[11px] text-muted-foreground"
                  >
                    {tool.name}
                  </code>
                </div>
                {label.description && (
                  <p className="text-xs leading-5 text-muted-foreground">{label.description}</p>
                )}
                <pre
                  data-testid="approval-arguments"
                  className="max-h-80 overflow-auto rounded-md bg-muted/50 p-3 text-[11px] leading-5 whitespace-pre-wrap break-all"
                >
                  {pretty(tool.args) ?? t("tool.missingArguments")}
                </pre>
              </div>
            );
          })}
          {interaction.external && <ExternalApprovals interaction={interaction} record={record} />}
          {interaction.rejectionReason && (
            <Alert variant="destructive" data-testid="rejection-reason">
              <AlertDescription>{interaction.rejectionReason}</AlertDescription>
            </Alert>
          )}
        </>
      ) : (
        interaction.questions.map((question, index) => (
          <fieldset key={`${interaction.id}:${question.question}`} className="space-y-2">
            <legend className="mb-2 text-sm">{question.question}</legend>
            {question.choices.length ? (
              question.choices.map((choice) => (
                <label key={choice} className="flex items-center gap-2 text-sm">
                  <input
                    type={question.multiple ? "checkbox" : "radio"}
                    name={`${interaction.id}-${index}`}
                    checked={
                      (pending ? answers[index] : recorded(index))?.includes(choice) ?? false
                    }
                    disabled={locked}
                    onChange={(event) =>
                      setAnswers((previous) =>
                        previous.map((answer, position) =>
                          position !== index
                            ? answer
                            : question.multiple
                              ? event.target.checked
                                ? [...answer, choice]
                                : answer.filter((value) => value !== choice)
                              : [choice],
                        ),
                      )
                    }
                  />
                  {choice}
                </label>
              ))
            ) : (
              <Textarea
                aria-label={question.question}
                placeholder={t("approval.answerPlaceholder")}
                disabled={locked}
                value={(pending ? answers[index] : recorded(index))?.[0] ?? ""}
                onChange={(event) =>
                  setAnswers((previous) =>
                    previous.map((answer, position) =>
                      position === index ? [event.target.value] : answer,
                    ),
                  )
                }
              />
            )}
          </fieldset>
        ))
      )}
      {respond.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t(errorKey(respond.error, "approval.submitFailed"))}</AlertDescription>
        </Alert>
      )}
      {pending && access.data?.operate && (
        <div className="flex flex-wrap gap-2">
          {approval && !interaction.external && (
            <>
              <Button
                disabled={locked}
                onClick={() =>
                  submit({
                    case: "approval",
                    value: {
                      approvals: interaction.tools.map((tool) => ({ id: tool.id, approved: true })),
                    },
                  })
                }
              >
                {t("approval.approve")}
              </Button>
              <Button
                variant="outline"
                disabled={locked}
                onClick={() =>
                  submit({
                    case: "approval",
                    value: {
                      approvals: interaction.tools.map((tool) => ({
                        id: tool.id,
                        approved: false,
                        rejectionReason: t("approval.rejected"),
                      })),
                    },
                  })
                }
              >
                {t("approval.reject")}
              </Button>
            </>
          )}
          {!approval && (
            <Button
              disabled={
                locked ||
                answers.some((answer) => !answer.length || answer.some((value) => !value.trim()))
              }
              onClick={() =>
                submit({
                  case: "answer",
                  value: { answers: answers.map((values) => ({ values })) },
                })
              }
            >
              {respond.isPending && <LoaderCircle className="animate-spin" />}
              {t("approval.submitAnswer")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
