import { create, isMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { useMutation } from "@connectrpc/connect-query";
import { useMutationState, useQueryClient } from "@tanstack/react-query";
import {
  ConsoleService,
  RespondInteractionRequestSchema,
} from "../../../gen/agentos/console/v1/console_service_pb.js";
import { type Interaction, InteractionSchema } from "../../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { awaiting } from "../status/activity.js";

export function useInteractionResponse(observed: Interaction) {
  const query = useQueryClient();
  const mutationKey = [
    ConsoleService.typeName,
    ConsoleService.method.respondInteraction.name,
    observed.taskId,
    observed.requestId,
  ];
  const filters = { mutationKey, exact: true };
  const respond = useMutation(ConsoleService.method.respondInteraction, { mutationKey });
  const submissions = useMutationState({
    filters,
    select: (mutation) => ({
      status: mutation.state.status,
      request: isMessage(mutation.state.variables, RespondInteractionRequestSchema)
        ? mutation.state.variables
        : undefined,
      error: mutation.state.error,
    }),
  });
  const accepted = submissions.findLast((submission) => submission.status === "success");
  const decision = accepted?.request?.decision;
  let interaction = observed;
  if (awaiting(observed.state) && decision?.case) {
    const approvals = decision.case === "approval" ? decision.value.approvals : [];
    interaction = create(InteractionSchema, {
      ...observed,
      state: approvals.some((approval) => !approval.approved)
        ? ActivityState.REJECTED
        : ActivityState.SUCCEEDED,
      answers: decision.case === "answer" ? decision.value.answers : [],
      rejectionReason: approvals.find((approval) => !approval.approved)?.rejectionReason ?? "",
    });
  }
  return {
    interaction,
    request: submissions.at(-1)?.request,
    sending: submissions.some((submission) => submission.status === "pending"),
    error: submissions.at(-1)?.error,
    submit(decision: MessageInitShape<typeof RespondInteractionRequestSchema>["decision"]) {
      if (
        !awaiting(interaction.state) ||
        query
          .getMutationCache()
          .findAll(filters)
          .some((mutation) => ["pending", "success"].includes(mutation.state.status))
      )
        return;
      respond.mutate(
        create(RespondInteractionRequestSchema, {
          taskId: observed.taskId,
          requestId: observed.requestId,
          decision,
        }),
      );
    },
  };
}
