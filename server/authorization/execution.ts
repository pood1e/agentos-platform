import { Code, ConnectError } from "@connectrpc/connect";
import type { Configuration } from "openid-client";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { toolBaseName } from "../../shared/tool-name.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import { agentKey } from "../read-model/agents.js";
import { agentRoles } from "./agent-role.js";
import { executions } from "./executions.js";
import { offlineCredentials } from "./offline.js";
import type { jwtIdentity } from "./oidc.js";
import { executionStore } from "./store.js";
import { authorizeToolSelection } from "./tools.js";
import { executionPrincipal } from "./workload-principal.js";
import { workloadConfiguration } from "./workloads.js";

export interface ExecutionAccessOptions {
  database: { uri: string; ca?: string };
  key: Uint8Array;
  clients: KagentClients;
  workspace: string;
  access: BindingView;
  verify: ReturnType<typeof jwtIdentity>;
  oauth: Configuration;
  metadata: ToolMetadata;
}

/** Execution bindings, offline grants and tool authorization shared by every platform process. */
export async function executionAccess(options: ExecutionAccessOptions) {
  const { clients, workspace, access, verify, metadata } = options;
  const persistent = await executionStore(
    options.database.uri,
    options.key,
    workspace,
    options.database.ca,
  );
  const background = offlineCredentials(persistent, options.oauth, verify);
  const registry = executions(persistent, verify, background.resolve, (root) => {
    const source = workloadConfiguration().executionSources.find(
      (entry) =>
        executionPrincipal(entry).subject === root.subject &&
        entry.agents.some((agent) => agentKey(agent) === agentKey(root.agent)),
    );
    return source && executionPrincipal(source);
  });
  const agentRole = agentRoles(clients);
  const authorizeTools = async (session: Session, tools: string[]) => {
    const context = await registry.resolve(session);
    const { engineer, role } = await agentRole(session);
    const bindings = await access();
    authorizeToolSelection(bindings, engineer, role, tools, context.write);
    if (
      await metadata.appOnlyCalls(
        tools.flatMap((tool) => bindings.environmentCalls(role.tools, toolBaseName(tool))),
        workspace,
      )
    )
      throw new ConnectError("App-only tools cannot be called by Agents", Code.PermissionDenied);
  };
  return {
    registry,
    store: persistent,
    background,
    agentRole,
    authorizeTools,
    close: persistent.close,
  };
}

export type ExecutionAccess = Awaited<ReturnType<typeof executionAccess>>;
