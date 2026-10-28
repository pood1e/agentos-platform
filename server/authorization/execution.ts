import { Code, ConnectError } from "@connectrpc/connect";
import type { Configuration } from "openid-client";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { scheduledIdentity } from "../automation/identity.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import { toolBaseName } from "../read-model/decode/tools.js";
import { agentRoles } from "./agent-role.js";
import { executions } from "./executions.js";
import { offlineCredentials } from "./offline.js";
import type { jwtIdentity } from "./oidc.js";
import { executionStore } from "./store.js";
import { authorizeToolSelection } from "./tools.js";

export interface ExecutionAccessOptions {
  database: { uri: string; ca?: string };
  key: Uint8Array;
  clients: KagentClients;
  workspace: string;
  access: BindingView;
  verify: ReturnType<typeof jwtIdentity>;
  oauth: Configuration;
  metadata: ToolMetadata;
  /** kagent creator of scheduled runs, whose sessions receive service identities. */
  nativeCreator: string;
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
  const registry = executions(
    persistent,
    verify,
    scheduledIdentity(clients, workspace, options.nativeCreator),
    background.resolve,
  );
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
