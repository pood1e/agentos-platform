import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import { LRUCache } from "lru-cache";
import { ActivityState } from "../../gen/agentos/console/v1/state_pb.js";
import type { Interaction } from "../../gen/agentos/console/v1/task_pb.js";
import { InteractionKind } from "../../gen/agentos/console/v1/task_pb.js";
import {
  type ChangeResult,
  ChangeState,
  Governance,
  type OperationsConfig,
} from "../../gen/agentos/governance/v1/change_pb.js";
import { ToolApprovalResponseSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import { pool } from "../kagent/clients.js";
import { hitlReply } from "../read-model/decode/hitl.js";
import type { TaskEntry } from "../read-model/entry.js";
import { awaiting, terminal } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { taskRun } from "../read-model/views/run.js";
import { changeId, digest } from "../shared/change-digest.js";
import type { ToolCatalog } from "./catalog.js";
import { changeClient } from "./client.js";
import { approvalEvidence } from "./evidence.js";
import messages from "./messages.json" with { type: "json" };
import { preparedChange } from "./preparation.js";
import { changeRequest, environmentFor } from "./requests.js";

/** Bridges native tool pauses to environment-owned work orders and their decisions. */
export function operationsCoordinator(
  sync: KagentSync,
  config: OperationsConfig,
  log: FastifyBaseLogger,
  catalog: ToolCatalog,
) {
  const connections = config.environments;
  const completed = new LRUCache<string, boolean>({ max: 5000 });
  let running = false,
    stopped = false;
  const errors = new LRUCache<string, number>({ max: 1000 });

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      const managed = (entry: TaskEntry, item: Interaction) =>
        awaiting(item.state) || entry.managedApprovals?.includes(item.requestId);
      const tasks = sync.index
        .all()
        .filter((entry) =>
          entry.interactions.some(
            (item) =>
              item.kind === InteractionKind.APPROVAL &&
              managed(entry, item) &&
              !completed.has(item.id),
          ),
        );
      await pool(tasks, 4, async (entry) => {
        for (const interaction of entry.interactions) {
          if (
            interaction.kind !== InteractionKind.APPROVAL ||
            !managed(entry, interaction) ||
            completed.has(interaction.id)
          )
            continue;
          try {
            const decisions = [];
            const preparations: {
              client: ReturnType<typeof changeClient>;
              id: string;
              index: number;
            }[] = [];
            let waiting = false;
            for (const tool of interaction.tools) {
              const connection = environmentFor(connections, tool.name);
              if (!connection) throw new Error("Tool has no managed work-order environment");
              if (connection.environment?.governance === Governance.DIRECT) {
                decisions.push({ id: tool.id, approved: true, rejectionReason: "" });
                continue;
              }
              const client = changeClient(connection),
                request = changeRequest(entry, interaction, tool);
              let result: ChangeResult | undefined;
              try {
                ({ result } = await client.getChange({ id: changeId(request.taskId, tool.id) }));
              } catch (error) {
                if (ConnectError.from(error).code !== Code.NotFound) throw error;
                if (!awaiting(interaction.state)) continue;
                const run = await taskRun(sync, entry.id);
                if (!run || !connection.environment)
                  throw new Error("Native execution evidence is unavailable");
                request.preparation = preparedChange(
                  run.calls,
                  tool.callId,
                  request.tool?.name ?? "",
                  request.tool?.args ?? {},
                );
                if (!request.preparation) {
                  decisions.push({
                    id: tool.id,
                    approved: false,
                    rejectionReason:
                      "变更方案未准备：请调用 prepare_change，提供准确工具和参数、影响、验证及回退计划；适用的仿真证据可一并提供。之后使用完全相同的参数调用写工具。未创建审批工单，未执行变更。",
                  });
                  continue;
                }
                request.evidence = approvalEvidence(
                  run.calls,
                  tool.callId,
                  connection.environment.name,
                  catalog,
                );
                ({ result } = await client.registerChange({ request }));
              }
              if (!result?.change) throw new Error("Environment did not return a change");
              if (!awaiting(interaction.state)) {
                const call = terminal(entry.state)
                  ? (await taskRun(sync, entry.id))?.calls.find((item) => item.id === tool.callId)
                  : undefined;
                if (
                  call &&
                  terminal(entry.state) &&
                  [
                    ActivityState.SUCCEEDED,
                    ActivityState.FAILED,
                    ActivityState.REJECTED,
                    ActivityState.CANCELED,
                  ].includes(call.state)
                )
                  await client.recordResult({
                    id: changeId(request.taskId, request.tool?.id ?? ""),
                    failed: call.state !== ActivityState.SUCCEEDED,
                    output: call.output,
                  });
                else if (terminal(entry.state))
                  await client.recordResult({
                    id: changeId(request.taskId, request.tool?.id ?? ""),
                    failed: true,
                    output: fromJson(
                      ValueSchema,
                      `Native task ${entry.id} ended before execution completed`,
                    ),
                  });
                else waiting = true;
                continue;
              }
              if (
                ![ChangeState.APPROVED, ChangeState.REJECTED, ChangeState.CANCELED].includes(
                  result.change.state,
                )
              ) {
                waiting = true;
                continue;
              }
              const approved = result.change.state === ChangeState.APPROVED;
              const copy =
                messages[/\p{Script=Han}/u.test(request.intent || request.prompt) ? "zh" : "en"];
              decisions.push({
                id: tool.id,
                approved,
                rejectionReason: approved
                  ? ""
                  : result.change.reason ||
                    (result.change.state === ChangeState.REJECTED ? copy.rejected : copy.closed),
              });
              if (approved)
                preparations.push({ client, id: result.change.id, index: decisions.length - 1 });
            }
            if (waiting) continue;
            if (awaiting(interaction.state)) {
              for (const preparation of preparations) {
                try {
                  await preparation.client.prepareExecution({ id: preparation.id });
                } catch (error) {
                  if (ConnectError.from(error).code !== Code.AlreadyExists) throw error;
                  const decision = decisions[preparation.index];
                  if (decision) {
                    decision.approved = false;
                    decision.rejectionReason =
                      "An identical operation is already awaiting execution. Retry after it finishes.";
                  }
                }
              }
              const reply = hitlReply(
                { taskId: entry.id, contextId: entry.contextId },
                `change-${entry.id}-${digest(interaction.requestId)}`,
                {
                  type: "tool_approval_response",
                  value: create(ToolApprovalResponseSchema, { approvals: decisions }),
                },
                "Work-order decisions have been verified by the target environments.",
              );
              reply.metadata = {
                ...reply.metadata,
                "agentos.dev/change-request": interaction.requestId,
              };
              await sync.send(entry.agentId, reply);
            } else completed.set(interaction.id, true);
            errors.delete(interaction.id);
          } catch (error) {
            if (Date.now() - (errors.get(interaction.id) ?? 0) > 60_000) {
              log.warn(
                { err: error, taskId: entry.id },
                "Work-order synchronization failed; execution remains paused",
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
  const timer = setInterval(() => void run(), 2000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
