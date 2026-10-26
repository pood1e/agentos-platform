import { fromJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  GetScheduledRunExecutionResultRequestSchema,
  GetScheduledRunExecutionResultResponseSchema,
  ScheduledExecutionQuerySchema,
  type ScheduledRunPreset,
} from "../../gen/agentos/automation/v1/service_pb.js";
import { ListScheduledRunExecutionsResponseSchema } from "../../gen/kagent/api/v1/scheduled_runs_pb.js";
import resultSchema from "../../gen/schema/agentos.automation.v1.GetScheduledRunExecutionResultRequest.jsonschema.bundle.json" with {
  type: "json",
};
import querySchema from "../../gen/schema/agentos.automation.v1.ScheduledExecutionQuery.jsonschema.bundle.json" with {
  type: "json",
};
import type { KagentClients } from "../kagent/clients.js";
import type { KagentSync } from "../read-model/sync.js";
import { inputSchema, result } from "../team-sessions/schema.js";
import { scheduledExecutionResult } from "./results.js";

export function scheduledSourceTools(
  clients: KagentClients,
  sync: KagentSync,
  workspace: string,
  presets: ScheduledRunPreset[],
  allowed: string[],
) {
  const available = () => presets.filter((preset) => allowed.includes(preset.key));
  return createMcpHandler(() => {
    const server = new McpServer({ name: "automation-results", version: "1.0.0" });
    server.registerTool(
      "list_scheduled_run_executions",
      {
        description: "Read execution history of an explicitly authorized solution preset.",
        inputSchema: inputSchema(querySchema),
        annotations: { readOnlyHint: true },
      },
      async (args, context) => {
        const query = fromJson(ScheduledExecutionQuerySchema, args);
        const preset = available().find((item) => item.key === query.presetKey);
        if (!preset) throw new ConnectError("Preset is not authorized", Code.PermissionDenied);
        return result(
          ListScheduledRunExecutionsResponseSchema,
          await clients.schedules.listScheduledRunExecutions(
            {
              scheduledRunId: preset.scheduledRunId,
              page: query.page,
            },
            { signal: context.mcpReq.signal, timeoutMs: 15_000 },
          ),
        );
      },
    );
    server.registerTool(
      "get_scheduled_run_execution_result",
      {
        description:
          "Read paginated, redacted native task and tool results of an authorized scheduled execution.",
        inputSchema: inputSchema(resultSchema),
        annotations: { readOnlyHint: true },
      },
      async (args, context) =>
        result(
          GetScheduledRunExecutionResultResponseSchema,
          await scheduledExecutionResult(
            clients,
            sync,
            workspace,
            fromJson(GetScheduledRunExecutionResultRequestSchema, args),
            async (id) => {
              if (!available().some((preset) => preset.scheduledRunId === id))
                throw new ConnectError("Execution is not authorized", Code.PermissionDenied);
            },
            context.mcpReq.signal,
          ),
        ),
    );
    return server;
  });
}
