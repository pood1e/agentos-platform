import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import {
  AutomationPresetsSchema,
  type ScheduledRunPreset,
  ScheduledRunPresetSchema,
} from "../../gen/agentos/automation/v1/service_pb.js";
import type { KagentClients } from "../kagent/clients.js";

export function automationPresets(workspace: string, dir?: string) {
  const prefix = `preset/${workspace}/`;
  const scheduledRuns: ScheduledRunPreset[] = [];
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
    request.requestId = `${prefix}${request.requestId}`;
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
  if (
    Object.entries(presets.scheduledRunPrompts).some(
      ([key, prompt]) => !ids.has(key) || !prompt.trim(),
    )
  )
    throw new Error("Managed instructions require an existing preset key and a nonempty prompt");
  return {
    eventTriggers: presets.eventTriggers,
    scheduledRuns,
    async seed(clients: KagentClients) {
      const references: ScheduledRunPreset[] = [];
      for (const request of presets.scheduledRuns) {
        const { scheduledRun } = await clients.schedules.createScheduledRun(request, {
          timeoutMs: 15_000,
        });
        if (!scheduledRun?.id || scheduledRun.agent?.namespace !== workspace)
          throw new Error("Automation preset requires a workspace schedule");
        const prompt = presets.scheduledRunPrompts[request.requestId.slice(prefix.length)];
        if (prompt && scheduledRun.config && prompt !== scheduledRun.config.prompt) {
          await clients.schedules.updateScheduledRun(
            {
              scheduledRunId: scheduledRun.id,
              etag: scheduledRun.etag,
              config: { ...scheduledRun.config, prompt },
            },
            { timeoutMs: 15_000 },
          );
        }
        references.push(
          create(ScheduledRunPresetSchema, {
            key: request.requestId.slice(prefix.length),
            scheduledRunId: scheduledRun.id,
          }),
        );
      }
      scheduledRuns.splice(0, scheduledRuns.length, ...references);
    },
  };
}
