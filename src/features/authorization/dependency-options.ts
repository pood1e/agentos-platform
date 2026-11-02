import { create } from "@bufbuild/protobuf";
import type { GetConfigurationResponse } from "../../../gen/agentos/console/v1/console_service_pb.js";
import {
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../../../gen/kagent/api/v1/authorization_pb.js";

export function dependencyOptions(
  workspace: string,
  kind: AuthorizationScopeKind,
  configuration: GetConfigurationResponse | undefined,
) {
  const resources = [];
  if (kind === AuthorizationScopeKind.HARNESS || kind === AuthorizationScopeKind.MODEL_CONNECTION)
    for (const item of (kind === AuthorizationScopeKind.HARNESS
      ? configuration?.harnesses
      : configuration?.modelConfigs) ?? []) {
      if (!item.ref?.name || item.ref.namespace !== workspace) continue;
      resources.push({
        label: item.ref.name,
        resource: create(AuthorizationResourceSchema, {
          resource: { case: "kubernetes", value: { kind, ref: item.ref } },
        }),
      });
    }
  if (kind === AuthorizationScopeKind.MCP_SERVER || kind === AuthorizationScopeKind.MCP_TOOL)
    for (const server of configuration?.toolServers ?? []) {
      const [namespace, name, extra] = server.ref.split("/");
      if (
        namespace !== workspace ||
        !name ||
        extra !== undefined ||
        server.groupKind !== "RemoteMCPServer.api.kagent.dev"
      )
        continue;
      const reference = {
        kind: AuthorizationScopeKind.MCP_SERVER,
        ref: { namespace, name },
      };
      if (kind === AuthorizationScopeKind.MCP_SERVER)
        resources.push({
          label: name,
          resource: create(AuthorizationResourceSchema, {
            resource: { case: "kubernetes", value: reference },
          }),
        });
      else
        for (const tool of server.discoveredTools)
          resources.push({
            label: `${name} / ${tool.name}`,
            resource: create(AuthorizationResourceSchema, {
              resource: { case: "mcpTool", value: { server: reference, name: tool.name } },
            }),
          });
    }
  return resources;
}
