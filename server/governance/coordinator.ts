import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { type Interaction, InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import { CoordinationJobSchema } from "../../gen/agentos/execution/v1/coordination_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import {
  type Approval,
  ApprovalContextSchema,
  ApprovalSchema,
  type GovernanceConfig,
} from "../../gen/agentos/governance/v1/governance_pb.js";
import { HitlToolSchema, ToolApprovalResponseSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import type { EnvironmentTokens } from "../authorization/environment-tokens.js";
import type { Coordinator } from "../jobs/coordination.js";
import { withApprovalDecisions } from "../read-model/decode/approval-decisions.js";
import { hitlReply } from "../read-model/decode/hitl.js";
import { object } from "../read-model/decode/messages.js";
import { toolBaseName } from "../read-model/decode/tools.js";
import type { TaskProjection } from "../read-model/projection.js";
import { awaiting, terminal } from "../read-model/state.js";
import { taskRun } from "../read-model/views/run.js";
import { messageIdentity } from "../shared/idempotency.js";
import { approvalClient, approvalEnvironment } from "./client.js";

/** External approval operations are idempotent against the native task/tool reference. */
export function approvalCoordinator(
  projection: Pick<TaskProjection, "entry" | "fullTask" | "send">,
  config: GovernanceConfig,
  authorize?: (contextId: string, tools: string[]) => Promise<void>,
  token?: EnvironmentTokens,
): Coordinator {
  async function permitted(
    entry: { id: string; contextId: string; agentId: string },
    interaction: Interaction,
  ) {
    if (!authorize) return true;
    try {
      await authorize(
        entry.contextId,
        interaction.tools.map((tool) => tool.name),
      );
      return true;
    } catch (error) {
      const failure = ConnectError.from(error);
      if (![Code.PermissionDenied, Code.Unauthenticated].includes(failure.code)) throw error;
      await projection.send(
        entry.agentId,
        withApprovalDecisions(
          hitlReply(
            { taskId: entry.id, contextId: entry.contextId },
            messageIdentity("authorization", entry.id, interaction.requestId),
            {
              type: "tool_approval_response",
              value: create(ToolApprovalResponseSchema, {
                approvals: interaction.tools.map((tool) => ({
                  id: tool.id,
                  approved: false,
                  rejectionReason:
                    failure.rawMessage || "Execution permissions do not allow this operation",
                })),
              }),
            },
            "The operation was blocked by execution authorization",
          ),
          interaction.tools.map((tool) =>
            create(ApprovalSchema, {
              id: tool.id,
              state: ActivityState.FAILED,
              reason: failure.rawMessage || "Execution permissions do not allow this operation",
              reference: { taskId: entry.id, toolId: tool.id },
            }),
          ),
        ),
      );
      return false;
    }
  }
  return {
    name: "approvals",
    select(graph, ids) {
      return [...ids].flatMap((id) => {
        const entry = graph.entry(id);
        return (
          entry?.interactions.flatMap((interaction) =>
            interaction.kind === InteractionKind.APPROVAL &&
            (awaiting(interaction.state) || terminal(entry.state)) &&
            interaction.tools.some(
              (tool) => approvalEnvironment(config.environments, tool.name)?.approvalUrl,
            )
              ? [
                  create(CoordinationJobSchema, {
                    taskId: entry.id,
                    work: { case: "approvalId", value: interaction.id },
                  }),
                ]
              : [],
          ) ?? []
        );
      });
    },
    async run(reference) {
      const entry = await projection.entry(reference.taskId);
      const interaction = entry?.interactions.find((item) => item.id === reference.work.value);
      if (!entry || !interaction) return;
      const pendingApproval = awaiting(interaction.state) && !terminal(entry.state);
      if (pendingApproval && !(await permitted(entry, interaction))) return;
      const targets = interaction.tools.map((tool) => ({
        tool,
        connection: approvalEnvironment(config.environments, tool.name),
      }));
      if (targets.some(({ connection }) => !connection?.approvalUrl))
        throw new Error("A tool pause cannot mix native and external decision authorities");
      const run = await taskRun(entry, projection.fullTask);
      if (!run) throw new Error("Native execution is unavailable");
      const decisions = [];
      const outcomes: Approval[] = [];
      const preparations = [];
      let waiting = false;
      for (const { tool, connection } of targets) {
        if (!connection) continue;
        const client = approvalClient(connection, token);
        const reference = { taskId: entry.id, toolId: tool.id };
        if (!pendingApproval) {
          const call = run.calls.find((item) => item.id === tool.callId);
          if (!terminal(entry.state)) {
            waiting = true;
            continue;
          }
          await client
            .recordApprovalResult(
              {
                reference,
                failed: !call || call.state !== ActivityState.SUCCEEDED,
                output:
                  call?.output ??
                  fromJson(ValueSchema, `Native task ${entry.id} ended before execution completed`),
              },
              { timeoutMs: 10_000 },
            )
            .catch((error) => {
              if (ConnectError.from(error).code !== Code.NotFound) throw error;
            });
          continue;
        }
        const context = create(ApprovalContextSchema, {
          agentId: entry.agentId,
          taskId: entry.id,
          contextId: entry.contextId,
          requestId: interaction.requestId,
          intent: interaction.explanation,
          prompt: entry.prompt,
          calls: run.calls,
          tool: create(HitlToolSchema, {
            id: tool.id,
            callId: tool.callId,
            name: toolBaseName(tool.name),
            args: object(tool.args ? toJson(ValueSchema, tool.args) : {}),
          }),
        });
        let approval: Approval | undefined;
        try {
          approval = (await client.getApproval({ reference }, { timeoutMs: 10_000 })).approval;
        } catch (error) {
          if (ConnectError.from(error).code !== Code.NotFound) throw error;
          approval = (await client.reviewApproval({ context }, { timeoutMs: 10_000 })).approval;
        }
        if (!approval) throw new Error("External decision service returned no approval");
        if (
          ![
            ActivityState.SUCCEEDED,
            ActivityState.REJECTED,
            ActivityState.CANCELED,
            ActivityState.FAILED,
          ].includes(approval.state)
        ) {
          waiting = true;
          continue;
        }
        const approved = approval.state === ActivityState.SUCCEEDED;
        outcomes.push(
          create(ApprovalSchema, {
            id: approval.id,
            state: approval.state,
            reason: approval.reason,
            decidedBy: approval.decidedBy,
            reference,
          }),
        );
        decisions.push({
          id: tool.id,
          approved,
          rejectionReason: approved ? "" : approval.reason || "The operation was declined",
        });
        if (approved) preparations.push({ client, reference, index: decisions.length - 1 });
      }
      if (waiting) return 2;
      if (pendingApproval) {
        const pending = async () => {
          const current = await projection.entry(entry.id);
          return (
            current &&
            !terminal(current.state) &&
            current.interactions.some(
              (item) => item.requestId === interaction.requestId && awaiting(item.state),
            )
          );
        };
        if (!(await pending())) return;
        if (!(await permitted(entry, interaction))) return;
        for (const preparation of preparations) {
          try {
            await preparation.client.prepareApproval(
              { reference: preparation.reference },
              { timeoutMs: 10_000 },
            );
          } catch (error) {
            if (ConnectError.from(error).code !== Code.AlreadyExists) throw error;
            const decision = decisions[preparation.index];
            if (decision) {
              decision.approved = false;
              decision.rejectionReason = "An identical operation is already awaiting execution";
              const outcome = outcomes[preparation.index];
              if (outcome) {
                outcome.state = ActivityState.FAILED;
                outcome.reason = decision.rejectionReason;
              }
            }
          }
        }
        if (!(await pending())) return;
        const reply = hitlReply(
          { taskId: entry.id, contextId: entry.contextId },
          messageIdentity("approval", entry.id, interaction.requestId),
          {
            type: "tool_approval_response",
            value: create(ToolApprovalResponseSchema, { approvals: decisions }),
          },
          "External decisions have been verified",
        );
        reply.metadata = {
          ...reply.metadata,
          "agentos.dev/approval-request": interaction.requestId,
        };
        await projection.send(entry.agentId, withApprovalDecisions(reply, outcomes));
        return 2;
      }
      return;
    },
  };
}
