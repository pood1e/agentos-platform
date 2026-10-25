import { create, type JsonObject, toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
  isToolVisibilityModelOnly,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import {
  ApprovalReferenceSchema,
  type GovernanceConfig,
} from "../../gen/agentos/governance/v1/governance_pb.js";
import type { AppReference } from "../../gen/agentos/mcp/v1/app_pb.js";
import { approvalAppReferenceKey } from "../../shared/mcp-apps.js";
import { isAdministrator } from "../../shared/permissions.js";
import type { EnvironmentTokens } from "../authorization/environment-tokens.js";
import type { executionHistory } from "../console/history.js";
import { approvalClient, approvalEnvironment } from "../governance/client.js";
import type { KagentClients } from "../kagent/clients.js";
import { ingest } from "../read-model/entry.js";
import { awaiting, terminal } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { notFound, unavailable } from "../shared/errors.js";
import { withEnvironmentMcpClient } from "./client.js";

export function approvalApps(
  sync: KagentSync,
  clients: KagentClients,
  config: GovernanceConfig,
  history: ReturnType<typeof executionHistory>,
  token?: EnvironmentTokens,
) {
  const denied = () => new ConnectError("Approval App access denied", Code.PermissionDenied);
  async function origin(app: AppReference, identity: ExecutionIdentity, signal: AbortSignal) {
    if (app.origin.case !== "approvalToolId") throw denied();
    if (!isAdministrator(identity) && !(await history(identity)).entry(app.taskId))
      throw notFound("task.notFound");
    const entry = sync.index.entry(app.taskId);
    const toolId = app.origin.value;
    const tool = entry?.interactions
      .flatMap((item) => item.tools)
      .find((tool) => tool.id === toolId);
    const connection = tool && approvalEnvironment(config.environments, tool.name);
    if (!entry || !connection?.approvalUrl || !token) throw unavailable();
    const reference = create(ApprovalReferenceSchema, { taskId: app.taskId, toolId });
    const { approval } = await approvalClient(connection, token).getApproval(
      { reference },
      { signal, timeoutMs: 10_000 },
    );
    if (!approval?.app) throw notFound("mcpApp.unavailable");
    return { entry, connection, reference, approval, view: approval.app };
  }
  async function connect<T>(
    source: Awaited<ReturnType<typeof origin>>,
    identity: ExecutionIdentity,
    signal: AbortSignal,
    operation: Parameters<typeof withEnvironmentMcpClient<T>>[4],
  ) {
    if (!token) throw unavailable();
    const bearer = await token(source.connection.environment?.name ?? "", "catalog", identity);
    return withEnvironmentMcpClient(
      source.connection,
      new URL(source.connection.approvalUrl ?? ""),
      bearer,
      signal,
      operation,
    );
  }
  return {
    async resource(app: AppReference, identity: ExecutionIdentity, signal: AbortSignal) {
      const source = await origin(app, identity, signal);
      return connect(source, identity, signal, async (client, signal) => {
        const { tools } = await client.listTools({}, { signal });
        const tool = tools.find((tool) => tool.name === source.view.tool);
        const uri = tool && getToolUiResourceUri(tool);
        if (!tool?.annotations?.readOnlyHint || !uri || isToolVisibilityAppOnly(tool))
          throw denied();
        return client.readResource({ uri }, { signal });
      });
    },
    async call(
      app: AppReference,
      name: string,
      args: JsonObject,
      identity: ExecutionIdentity,
      signal: AbortSignal,
    ) {
      const source = await origin(app, identity, signal);
      return connect(source, identity, signal, async (client, signal) => {
        const { tools } = await client.listTools({}, { signal });
        const tool = tools.find((tool) => tool.name === name);
        if (!tool || isToolVisibilityModelOnly(tool)) throw denied();
        if (tool.annotations?.readOnlyHint !== true) {
          if (!identity.write || !isToolVisibilityAppOnly(tool)) throw denied();
          const task = await clients.a2a.getTask(
            { tenant: source.entry.agentId, id: app.taskId },
            { signal, timeoutMs: 5_000 },
          );
          const fresh = ingest(task, source.entry.agentId);
          if (
            terminal(fresh.state) ||
            !fresh.interactions.some(
              (item) =>
                awaiting(item.state) &&
                item.tools.some((tool) => tool.id === source.reference.toolId),
            )
          )
            throw denied();
        }
        return client.callTool(
          {
            name,
            arguments: args,
            _meta: {
              [approvalAppReferenceKey]: toJson(ApprovalReferenceSchema, source.reference),
            },
          },
          { signal },
        );
      });
    },
  };
}
