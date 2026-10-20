import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import { LRUCache } from "lru-cache";
import { InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import {
  type Approval,
  ApprovalContextSchema,
  type GovernanceConfig,
} from "../../gen/agentos/governance/v1/governance_pb.js";
import { HitlToolSchema, ToolApprovalResponseSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import { pool } from "../kagent/clients.js";
import { hitlReply } from "../read-model/decode/hitl.js";
import { object } from "../read-model/decode/messages.js";
import { toolBaseName } from "../read-model/decode/tools.js";
import { awaiting, terminal } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { taskRun } from "../read-model/views/run.js";
import { messageIdentity } from "../shared/idempotency.js";
import { approvalClient, approvalEnvironment } from "./client.js";

/** External policies decide native tool pauses; execution and history remain with kagent. */
export function approvalCoordinator(
  sync: KagentSync,
  config: GovernanceConfig,
  log: FastifyBaseLogger,
) {
  const completed = new LRUCache<string, boolean>({ max: 5000 });
  const errors = new LRUCache<string, number>({ max: 1000 });
  let running = false,
    stopped = false;
  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      await pool(sync.index.all(), 4, async (entry) => {
        for (const interaction of entry.interactions) {
          if (
            interaction.kind !== InteractionKind.APPROVAL ||
            completed.has(interaction.id) ||
            (!awaiting(interaction.state) && !terminal(entry.state))
          )
            continue;
          const targets = interaction.tools.map((tool) => ({
            tool,
            connection: approvalEnvironment(config.environments, tool.name),
          }));
          if (!targets.some(({ connection }) => connection?.approvalUrl)) continue;
          try {
            if (targets.some(({ connection }) => !connection?.approvalUrl))
              throw new Error("A tool pause cannot mix native and external decision authorities");
            const run = await taskRun(sync, entry.id);
            if (!run) throw new Error("Native execution is unavailable");
            const decisions = [];
            const preparations = [];
            let waiting = false;
            for (const { tool, connection } of targets) {
              if (!connection) continue;
              const client = approvalClient(connection);
              const reference = { taskId: entry.id, toolId: tool.id };
              if (!awaiting(interaction.state)) {
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
                        fromJson(
                          ValueSchema,
                          `Native task ${entry.id} ended before execution completed`,
                        ),
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
                approval = (await client.getApproval({ reference }, { timeoutMs: 10_000 }))
                  .approval;
              } catch (error) {
                if (ConnectError.from(error).code !== Code.NotFound) throw error;
                approval = (await client.reviewApproval({ context }, { timeoutMs: 10_000 }))
                  .approval;
              }
              if (!approval) throw new Error("External decision service returned no approval");
              if (
                ![ActivityState.SUCCEEDED, ActivityState.REJECTED, ActivityState.CANCELED].includes(
                  approval.state,
                )
              ) {
                waiting = true;
                continue;
              }
              const approved = approval.state === ActivityState.SUCCEEDED;
              decisions.push({
                id: tool.id,
                approved,
                rejectionReason: approved ? "" : approval.reason || "The operation was declined",
              });
              if (approved) preparations.push({ client, reference, index: decisions.length - 1 });
            }
            if (waiting) continue;
            if (awaiting(interaction.state)) {
              const pending = () => {
                const current = sync.index.entry(entry.id);
                return (
                  current &&
                  !terminal(current.state) &&
                  current.interactions.some(
                    (item) => item.requestId === interaction.requestId && awaiting(item.state),
                  )
                );
              };
              if (!pending()) continue;
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
                    decision.rejectionReason =
                      "An identical operation is already awaiting execution";
                  }
                }
              }
              if (!pending()) continue;
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
              await sync.send(entry.agentId, reply);
            } else completed.set(interaction.id, true);
            errors.delete(interaction.id);
          } catch (error) {
            if (Date.now() - (errors.get(interaction.id) ?? 0) > 60_000) {
              log.warn(
                { err: error, taskId: entry.id },
                "External approval synchronization failed; execution remains paused",
              );
              errors.set(interaction.id, Date.now());
            }
          }
        }
      });
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void run(), 2_000);
  timer.unref();
  void run();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
