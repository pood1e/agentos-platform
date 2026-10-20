import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/console/v1/state_pb.js";
import type { ToolCall } from "../../gen/agentos/console/v1/task_pb.js";
import {
  type EnvironmentConnection,
  Governance,
  type PrepareChangeRequest,
  PrepareChangeRequestSchema,
  PrepareChangeResponseSchema,
} from "../../gen/agentos/governance/v1/change_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentInfo, systemRoles } from "../read-model/agents.js";
import { toolBaseName } from "../read-model/decode/tools.js";
import { ingest } from "../read-model/entry.js";
import { operationHash } from "../shared/change-digest.js";
import { requiresChangeReview, type ToolCatalog } from "./catalog.js";
import { environmentFor } from "./requests.js";

const validator = createValidator();

export class ChangePreparationError extends Error {}

/** Prepares an exact operation and verifies any supplied native simulation evidence. */
export function changePreparation(
  clients: KagentClients,
  namespace: string,
  environments: EnvironmentConnection[],
  catalog: ToolCatalog,
) {
  return async (request: PrepareChangeRequest) => {
    const valid = validator.validate(PrepareChangeRequestSchema, request);
    if (valid.kind !== "valid") throw new ChangePreparationError("Provide a complete change plan");
    const name = toolBaseName(request.toolName);
    const environment = environmentFor(environments, name)?.environment;
    if (environment?.governance !== Governance.APPROVAL)
      throw new ChangePreparationError("Prepare a change only for an approval environment");
    const local = name.slice(environment.name.length + 1),
      split = local.indexOf("_");
    const project = local.slice(0, split),
      tool = local.slice(split + 1);
    if (!catalog.projects.get(project)?.has(tool))
      throw new ChangePreparationError("Use a known managed environment tool");
    if (!requiresChangeReview(catalog, project, tool))
      throw new ChangePreparationError(
        "This operation uses native permissions and audit; call its tool directly without prepare_change or a work order",
      );
    const plan = request.plan;
    if (!plan || ![plan.impact, plan.validation, plan.rollback].every((value) => value.trim()))
      throw new ChangePreparationError("Provide impact, validation and rollback plans");
    const reference = plan.simulation;
    const preparation = create(PrepareChangeResponseSchema, {
      operationHash: operationHash(name, request.args ?? {}),
      plan,
    });
    if (!reference) return preparation;
    const [workspace, engineer, extra] = reference.tenant.split("/");
    if (workspace !== namespace || !engineer || extra || !reference.id)
      throw new ChangePreparationError(
        `Reference a simulation task in this workspace: use its actual Agent namespace/name under ${namespace}`,
      );
    const { agent } = await clients.agents.getAgent(
      { ref: { namespace, name: engineer } },
      { timeoutMs: 10000 },
    );
    if (!agent || systemRoles.has(agentInfo(agent).role))
      throw new ChangePreparationError("Validation must come from a workspace engineer");
    const task = await clients.a2a.getTask(
      { tenant: reference.tenant, id: reference.id },
      { timeoutMs: 10000 },
    );
    if (task.status?.state !== TaskState.COMPLETED)
      throw new ChangePreparationError("Wait for the simulation task to finish");
    const { session } = await clients.sessions.getSession(
      { sessionId: task.contextId },
      { timeoutMs: 10000 },
    );
    if (session?.agent?.namespace !== workspace || session.agent.name !== engineer)
      throw new ChangePreparationError("Validation task belongs to a different engineer context");
    const entry = ingest(task, reference.tenant);
    const evidence = entry.calls.filter(
      (call) =>
        call.state === ActivityState.SUCCEEDED &&
        environmentFor(environments, call.name)?.environment?.governance === Governance.DIRECT,
    );
    if (!entry.answer.trim() || !evidence.length)
      throw new ChangePreparationError(
        "The simulation report must include observed environment evidence",
      );
    preparation.simulationReport =
      `${reference.tenant} / ${task.id}\n${evidence.map((call) => toolBaseName(call.name)).join(", ")}\n\n${entry.answer}`.slice(
        0,
        16000,
      );
    return preparation;
  };
}

/** Selects a successful preparation before the exact paused write call. */
export function preparedChange(calls: ToolCall[], callId: string, tool: string, args: object) {
  const position = calls.findIndex((call) => call.id === callId);
  if (position < 0) return undefined;
  for (const call of calls.slice(0, position).reverse()) {
    if (
      toolBaseName(call.name) !== "prepare_change" ||
      call.state !== ActivityState.SUCCEEDED ||
      !call.output
    )
      continue;
    try {
      const result = fromJson(PrepareChangeResponseSchema, toJson(ValueSchema, call.output));
      if (
        validator.validate(PrepareChangeResponseSchema, result).kind === "valid" &&
        result.operationHash ===
          operationHash(toolBaseName(tool), args as Parameters<typeof operationHash>[1])
      )
        return result;
    } catch {}
  }
  return undefined;
}
