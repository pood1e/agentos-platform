import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import type { AutomationService } from "../../gen/agentos/automation/v1/service_pb.js";
import type { ScheduledRun } from "../../gen/kagent/api/v1alpha1/scheduled_runs_pb.js";
import { can } from "../../shared/permissions.js";
import type { KagentClients } from "../kagent/clients.js";
import { requestIdentity } from "../platform/access.js";
import type { automationPresets } from "./presets.js";

const missing = () => new ConnectError("Automation not found", Code.NotFound);

export function automationService(
  clients: KagentClients,
  workspace: string,
  presets: Pick<ReturnType<typeof automationPresets>, "eventTriggers"> = { eventTriggers: [] },
  environments: string[] = [],
  ingressEnabled = false,
): ServiceImpl<typeof AutomationService> {
  const native = clients.schedules;
  const options = (context: HandlerContext) => ({ signal: context.signal, timeoutMs: 15_000 });
  const scoped = (schedule?: ScheduledRun) => schedule?.agent?.namespace === workspace;
  const manage = (context: HandlerContext) => {
    if (!can(context.values.get(requestIdentity), Capability.TASKS_MANAGE))
      throw new ConnectError("Permission denied", Code.PermissionDenied);
  };
  const get = async (id: string, context: HandlerContext) => {
    const response = await native.getScheduledRun({ scheduledRunId: id }, options(context));
    if (!scoped(response.scheduledRun)) throw missing();
    return response;
  };
  return {
    async listScheduledRuns(request, context) {
      const seen = new Set<string>();
      let token = request.page?.pageToken ?? "";
      for (;;) {
        if (seen.has(token)) throw new ConnectError("Invalid upstream cursor", Code.Unavailable);
        seen.add(token);
        const response = await native.listScheduledRuns(
          { page: { limit: request.page?.limit, pageToken: token } },
          options(context),
        );
        response.scheduledRuns = response.scheduledRuns.filter(scoped);
        token = response.page?.nextPageToken ?? "";
        if (response.scheduledRuns.length || !token) return response;
      }
    },
    getScheduledRun: (request, context) => get(request.scheduledRunId, context),
    async createScheduledRun(request, context) {
      manage(context);
      if (request.agent?.namespace !== workspace) throw missing();
      return native.createScheduledRun(request, options(context));
    },
    async updateScheduledRun(request, context) {
      manage(context);
      await get(request.scheduledRunId, context);
      return native.updateScheduledRun(request, options(context));
    },
    async deleteScheduledRun(request, context) {
      manage(context);
      await get(request.scheduledRunId, context);
      return native.deleteScheduledRun(request, options(context));
    },
    async triggerScheduledRun(request, context) {
      manage(context);
      await get(request.scheduledRunId, context);
      return native.triggerScheduledRun(request, options(context));
    },
    async getScheduledRunExecution(request, context) {
      const response = await native.getScheduledRunExecution(request, options(context));
      if (!response.execution) throw missing();
      await get(response.execution.scheduledRunId, context);
      return response;
    },
    async listScheduledRunExecutions(request, context) {
      await get(request.scheduledRunId, context);
      return native.listScheduledRunExecutions(request, options(context));
    },
    listEventTriggers: () => ({
      eventTriggers: environments.flatMap((environment) =>
        presets.eventTriggers.map((trigger) => ({
          trigger,
          environment,
          ingressEnabled,
        })),
      ),
    }),
  };
}
