import { Code } from "@connectrpc/connect";
import type {
  CreateScheduledRunRequest,
  DeleteScheduledRunRequest,
  ListScheduledRunExecutionsRequest,
  ListScheduledRunsRequest,
  TriggerScheduledRunRequest,
  UpdateScheduledRunRequest,
} from "../../gen/kagent/api/v1/scheduled_runs_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { conflict, hasCode, invalid, notFound, precondition } from "../shared/errors.js";
import { executionTarget } from "./visibility.js";

const options = { timeoutMs: 30_000 };

/** Native rejections the workbench can explain; other failures keep their native status. */
function explained(error: unknown): never {
  if (hasCode(error, Code.InvalidArgument)) throw invalid("schedule.invalid");
  if (hasCode(error, Code.Aborted)) throw conflict("schedule.conflict");
  if (hasCode(error, Code.FailedPrecondition)) throw precondition("schedule.unavailable");
  if (hasCode(error, Code.NotFound)) throw notFound("schedule.notFound");
  throw error;
}

/**
 * The caller's native schedules for Agents of this workspace. kagent owns ownership, captured
 * authority and execution; every firing runs as the creator with their background delegation.
 */
export function scheduleCommands(
  clients: KagentClients,
  namespace: string,
  renewable: () => Promise<boolean>,
) {
  const native = clients.scheduledRuns;
  async function owned(scheduledRunId: string) {
    const { scheduledRun } = await native
      .getScheduledRun({ scheduledRunId }, options)
      .catch(explained);
    if (scheduledRun?.agent?.namespace !== namespace || scheduledRun.deletedAt)
      throw notFound("schedule.notFound");
  }
  async function delegated() {
    if (!(await renewable())) throw precondition("delegation.required");
  }
  return {
    async list(request: ListScheduledRunsRequest) {
      const response = await native.listScheduledRuns(request, options);
      response.scheduledRuns = response.scheduledRuns.filter(
        (run) => run.agent?.namespace === namespace && !run.deletedAt,
      );
      return response;
    },
    async create(request: CreateScheduledRunRequest) {
      executionTarget(namespace, request.agent);
      await delegated();
      return native.createScheduledRun(request, options).catch(explained);
    },
    async update(request: UpdateScheduledRunRequest) {
      await owned(request.scheduledRunId);
      await delegated();
      return native.updateScheduledRun(request, options).catch(explained);
    },
    async remove(request: DeleteScheduledRunRequest) {
      await owned(request.scheduledRunId);
      return native.deleteScheduledRun(request, options).catch(explained);
    },
    async trigger(request: TriggerScheduledRunRequest) {
      await owned(request.scheduledRunId);
      await delegated();
      return native.triggerScheduledRun(request, options).catch(explained);
    },
    async executions(request: ListScheduledRunExecutionsRequest) {
      await owned(request.scheduledRunId);
      return native.listScheduledRunExecutions(request, options);
    },
  };
}
