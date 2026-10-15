import { create, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { ApprovalTool, Interaction } from "../../gen/agentos/console/v1/task_pb.js";
import {
  ChangeRequestSchema,
  type EnvironmentConnection,
} from "../../gen/agentos/governance/v1/change_pb.js";
import { HitlToolSchema, type ToolActivity } from "../../gen/agentos/kagent/v1/wire_pb.js";
import { object } from "../read-model/decode/messages.js";
import { toolBaseName } from "../read-model/decode/tools.js";
import type { TaskEntry } from "../read-model/entry.js";

export function environmentFor(connections: EnvironmentConnection[], name: string) {
  const tool = toolBaseName(name);
  return connections.find(
    (item) => item.environment && tool.startsWith(`${item.environment.name}-`),
  );
}

export function changeRequest(
  entry: TaskEntry,
  interaction: Interaction,
  tool: ApprovalTool,
  evidence: ToolActivity[] = [],
) {
  return create(ChangeRequestSchema, {
    engineer: entry.agentId.split("/").at(-1),
    taskId: entry.id,
    contextId: entry.contextId,
    requestId: interaction.requestId,
    intent: interaction.explanation,
    prompt: entry.prompt.slice(0, 24000),
    evidence,
    tool: create(HitlToolSchema, {
      id: tool.id,
      callId: tool.callId,
      name: toolBaseName(tool.name),
      args: object(tool.args ? toJson(ValueSchema, tool.args) : {}),
    }),
  });
}
