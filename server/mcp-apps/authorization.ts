import { Code, ConnectError } from "@connectrpc/connect";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import type { ToolCall } from "../../gen/agentos/execution/v1/task_pb.js";
import type { AppReference } from "../../gen/agentos/mcp/v1/app_pb.js";
import { agentRoles } from "../authorization/agent-role.js";
import type { BindingView, ToolBindings } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { appOnly, appResource, appVisible, type ToolMetadata } from "../kagent/tool-metadata.js";
import type { TaskQueries } from "../read-model/queries.js";
import { taskRun } from "../read-model/views/run.js";
import { notFound } from "../shared/errors.js";

interface Dependencies {
  clients: KagentClients;
  projection: TaskQueries;
  namespace: string;
  access: BindingView;
  metadata: ToolMetadata;
}

export const appDenied = () =>
  new ConnectError("MCP App tool access denied", Code.PermissionDenied);

/** Every read and callback binds the viewer to the recorded call and current native selection. */
export function appAuthorization({
  clients,
  projection,
  namespace,
  access,
  metadata,
}: Dependencies) {
  const agentRole = agentRoles(clients);
  async function source(call: ToolCall, selectedPolicy?: ToolBindings) {
    const policy = selectedPolicy ?? (await access());
    const target = policy
      .appSources()
      .toSorted((a, b) => b.service.length - a.service.length)
      .find((target) =>
        call.mcpServer
          ? target.service === policy.serviceForRuntimeServer(call.mcpServer)
          : call.name.startsWith(`${target.service}_`),
      );
    if (!target) return;
    const server = (await metadata.servers()).find(
      (server) => server.ref === `${namespace}/${target.server}`,
    );
    if (!server) return;
    const tools = await metadata.tools(server);
    const unprefix = (value: string) =>
      value.startsWith(`${target.service}_`) ? value.slice(target.service.length + 1) : value;
    const tool = tools.find((tool) => unprefix(tool.name) === unprefix(call.name));
    if (!tool || appOnly(tool) || !appVisible(tool)) return;
    const uri = appResource(tool);
    return uri ? { target, server, tool, tools, uri, unprefix } : undefined;
  }

  async function authorize(
    reference: AppReference | undefined,
    identity: UserIdentity,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (!reference?.taskId || !reference.callId) throw notFound("mcpApp.unavailable");
    const entry = await projection.entry(reference.taskId);
    if (!entry || entry.subject !== identity.subject) throw notFound("task.notFound");
    const [{ session }, authority] = await Promise.all([
      clients.sessions.getSession({ sessionId: entry.contextId }, { signal, timeoutMs: 5_000 }),
      clients.execution.getSessionAuthority(
        { sessionId: entry.contextId },
        { signal, timeoutMs: 5_000 },
      ),
    ]);
    if (
      !session ||
      session.agent?.namespace !== namespace ||
      authority.revoked ||
      authority.authority?.initiatorId !== identity.subject ||
      authority.authority?.sessionId !== session.id
    )
      throw appDenied();
    const run = await taskRun(entry, projection.fullTask);
    const call = run?.calls.find((call) => call.id === reference.callId);
    const policy = await access();
    const origin = call && (await source(call, policy));
    if (!origin) throw notFound("mcpApp.unavailable");
    const { role } = await agentRole(session);
    const binding = policy.appBinding(role.tools, origin.target.service, [origin.tool.name]);
    if (!binding) throw appDenied();
    const tools = origin.tools.filter(
      (tool) =>
        appVisible(tool) && policy.appBinding([binding], origin.target.service, [tool.name]),
    );
    signal.throwIfAborted();
    return { ...origin, reference, call, binding, allowedTools: tools.map((tool) => tool.name) };
  }
  return { source, authorize };
}
