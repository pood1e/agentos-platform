import { clone, create } from "@bufbuild/protobuf";
import { durationFromMs, durationMs } from "@bufbuild/protobuf/wkt";
import type { ScheduleTemplate } from "../../../gen/agentos/console/v1/pack_pb.js";
import type { ResourceReference } from "../../../gen/kagent/api/v1/common_pb.js";
import {
  type ScheduledRun,
  type ScheduledRunConfig,
  ScheduledRunConfigSchema,
} from "../../../gen/kagent/api/v1/scheduled_runs_pb.js";

/** kagent applies 15 minutes when a schedule omits its execution timeout. */
const defaultMinutes = 15;

interface ScheduleDraft {
  agent?: ResourceReference;
  config: ScheduledRunConfig;
}

export const agentId = (agent?: ResourceReference) => `${agent?.namespace}/${agent?.name}`;

const copy = (config?: ScheduledRunConfig) =>
  config ? clone(ScheduledRunConfigSchema, config) : create(ScheduledRunConfigSchema);

export function newDraft(template?: ScheduleTemplate): ScheduleDraft {
  const config = copy(template?.config);
  config.timeZone ||= Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return { agent: template?.agent, config };
}

export const editDraft = (run: ScheduledRun): ScheduleDraft => ({
  agent: run.agent,
  config: copy(run.config),
});

/** The same configuration with another pause state. */
export function toggled(config?: ScheduledRunConfig) {
  const next = copy(config);
  next.paused = !next.paused;
  return next;
}

export const timeoutMinutes = (config: ScheduledRunConfig) =>
  config.executionTimeout ? durationMs(config.executionTimeout) / 60_000 : defaultMinutes;

export function withTimeout(config: ScheduledRunConfig, minutes: number) {
  const next = copy(config);
  next.executionTimeout = durationFromMs(Math.max(1, minutes) * 60_000);
  return next;
}

/** A template counts as enabled when the caller already schedules its Agent under its name. */
export const enabled = (template: ScheduleTemplate, runs: ScheduledRun[]) =>
  runs.some(
    (run) =>
      agentId(run.agent) === agentId(template.agent) && run.config?.name === template.config?.name,
  );
