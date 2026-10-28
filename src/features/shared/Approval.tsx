import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type Answer,
  type Interaction,
  InteractionKind,
  type Question,
} from "../../../gen/agentos/console/v1/task_pb.js";
import { errorKey } from "../../../shared/errors.js";
import { useAccess } from "../../lib/access.js";
import { awaiting } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { interactionLabel } from "./interaction-state.js";
import { Markdown } from "./Markdown.js";
import { ToolArguments } from "./ToolArguments.js";
import { ToolIcon } from "./ToolIcon.js";
import { useInteractionResponse } from "./use-interaction-response.js";
import { useToolText } from "./use-tool-text.js";

function answerDrafts(questions: Question[], answers: Answer[] = []) {
  return questions.map((question, index) => {
    const values = answers[index]?.values ?? [];
    return {
      selected: values.filter((value) => question.choices.includes(value)),
      text: values.filter((value) => !question.choices.includes(value)).join("\n"),
    };
  });
}

export function Approval({
  interaction: observed,
  operate,
}: {
  interaction: Interaction;
  operate: boolean;
}) {
  const { t } = useTranslation();
  const access = useAccess();
  const toolText = useToolText();
  const response = useInteractionResponse(observed);
  const { submit } = response;
  const interaction = response.interaction;
  const submitted = response.request?.decision;
  const [drafts, setDrafts] = useState(() =>
    answerDrafts(
      interaction.questions,
      submitted?.case === "answer" ? submitted.value.answers : [],
    ),
  );
  const selections =
    response.sending && submitted?.case === "answer"
      ? answerDrafts(interaction.questions, submitted.value.answers)
      : drafts;
  const answers = drafts.map(({ selected, text }) => [
    ...new Set([...selected, ...(text.trim() ? [text] : [])]),
  ]);
  const pending = awaiting(interaction.state);
  const approval = interaction.kind === InteractionKind.APPROVAL;
  const locked = !operate || !access.data || !pending || response.sending;
  const recorded = (index: number) => interaction.answers[index]?.values ?? [];
  return (
    <section className="space-y-4" data-testid="approval-detail">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-warning" />
        <h3 className="text-sm font-semibold">
          {t(approval ? "approval.title" : "approval.userInput")}
        </h3>
        <Status state={interaction.state}>{t(interactionLabel(interaction))}</Status>
      </div>
      {interaction.explanation && <Markdown>{interaction.explanation}</Markdown>}
      {approval ? (
        <>
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
                <ToolArguments value={tool.args} />
              </div>
            );
          })}
          {interaction.rejectionReason && (
            <Alert variant="destructive" data-testid="rejection-reason">
              <AlertDescription>
                {t(`approval.reasons.${interaction.rejectionReason}`, {
                  defaultValue: interaction.rejectionReason,
                })}
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : (
        interaction.questions.map((question, index) => (
          <fieldset key={`${interaction.id}:${question.question}`} className="space-y-2">
            <legend className="mb-2 text-sm">{question.question}</legend>
            {!pending ? (
              <p className="text-sm whitespace-pre-wrap wrap-anywhere">
                {recorded(index).join("\n") || "—"}
              </p>
            ) : (
              <>
                {question.choices.map((choice) => (
                  <label key={choice} className="flex items-center gap-2 text-sm">
                    <input
                      type={question.multiple ? "checkbox" : "radio"}
                      name={`${interaction.id}-${index}`}
                      checked={selections[index]?.selected.includes(choice) ?? false}
                      disabled={locked}
                      onChange={(event) =>
                        setDrafts((previous) =>
                          previous.map((answer, position) =>
                            position !== index
                              ? answer
                              : {
                                  selected: question.multiple
                                    ? event.target.checked
                                      ? [...answer.selected, choice]
                                      : answer.selected.filter((value) => value !== choice)
                                    : [choice],
                                  text: question.multiple ? answer.text : "",
                                },
                          ),
                        )
                      }
                    />
                    {choice}
                  </label>
                ))}
                {question.choices.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t(
                      question.multiple
                        ? "approval.multipleAnswerHint"
                        : "approval.singleAnswerHint",
                    )}
                  </p>
                )}
                <Textarea
                  aria-label={question.question}
                  placeholder={t(
                    question.choices.length
                      ? "approval.customAnswerPlaceholder"
                      : "approval.answerPlaceholder",
                  )}
                  disabled={locked}
                  value={selections[index]?.text ?? ""}
                  onChange={(event) =>
                    setDrafts((previous) =>
                      previous.map((answer, position) =>
                        position === index
                          ? {
                              selected: question.multiple ? answer.selected : [],
                              text: event.target.value,
                            }
                          : answer,
                      ),
                    )
                  }
                />
              </>
            )}
          </fieldset>
        ))
      )}
      {response.error && (
        <Alert variant="destructive">
          <AlertDescription>
            {t(errorKey(response.error, "approval.submitFailed"))}
          </AlertDescription>
        </Alert>
      )}
      {pending && operate && access.data && (
        <div className="flex flex-wrap gap-2">
          {approval && (
            <>
              <Button
                disabled={locked || !interaction.approve}
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
              {response.sending && <LoaderCircle className="animate-spin" />}
              {t("approval.submitAnswer")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
