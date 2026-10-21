import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { AutomationPresetsSchema } from "../../gen/agentos/automation/v1/service_pb.js";
import type { KagentClients } from "../kagent/clients.js";

export function automationPresets(workspace: string, dir?: string) {
  const path = dir && join(dir, "automation.json");
  const presets =
    path && existsSync(path)
      ? fromJsonString(AutomationPresetsSchema, readFileSync(path, "utf8"))
      : create(AutomationPresetsSchema);
  const ids = new Set<string>();
  for (const request of presets.scheduledRuns) {
    if (!request.requestId || ids.has(request.requestId))
      throw new Error("Automation preset IDs must be unique and nonempty");
    ids.add(request.requestId);
    request.requestId = `preset/${workspace}/${request.requestId}`;
    if (request.agent && !request.agent.namespace) request.agent.namespace = workspace;
    if (request.agent?.namespace !== workspace)
      throw new Error("Automation preset is outside the workspace");
  }
  for (const trigger of presets.eventTriggers) {
    if (trigger.agent && !trigger.agent.namespace) trigger.agent.namespace = workspace;
    if (
      !trigger.eventNamespace ||
      !trigger.source?.typePrefix ||
      !trigger.agent?.name ||
      trigger.agent.namespace !== workspace
    )
      throw new Error("Event trigger requires a source and workspace Agent");
  }
  if (createValidator().validate(AutomationPresetsSchema, presets).kind !== "valid")
    throw new Error("Invalid automation presets");
  return {
    eventTriggers: presets.eventTriggers,
    async seed(clients: KagentClients) {
      for (const request of presets.scheduledRuns)
        await clients.schedules.createScheduledRun(request, { timeoutMs: 15_000 });
    },
  };
}
