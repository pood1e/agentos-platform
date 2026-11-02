import type { ToolRequirement } from "../../../gen/agentos/console/v1/tool_pb.js";
import type { Connection } from "../../../gen/agentos/management/v1/management_pb.js";
import type { ToolServer } from "../../../gen/kagent/api/v1/tools_pb.js";

export const serverName = (server: ToolServer) => server.ref.split("/").at(-1) ?? server.ref;

/** An execution identity reaches an environment service only through its own identity. */
export const ownIdentities = (identity: string, service: Connection) =>
  service.credentialBindings
    .filter((binding) => binding.identity === identity)
    .flatMap((binding) => (binding.server ? [binding.server] : []));

/** Environment services need an execution identity; other services are shared. */
export const serviceServers = (identity: string, service: Connection, environment: boolean) =>
  environment
    ? ownIdentities(identity, service)
    : [
        service.credentialBindings.find((binding) => binding.identity === "catalog")?.server ??
          service.credentialBindings[0]?.server,
      ].flatMap((server) => (server ? [server] : []));

const key = (server: string, tool: string) => `${server}\u0000${tool}`;

/** Execution confirmation requirements for bindable tools, keyed by server and tool. */
export function toolRequirements(permissions: ToolRequirement[] | undefined) {
  const decisions = new Map(
    permissions?.map((item) => [key(item.server, item.tool), item.requireApproval]),
  );
  return (server: string, tool: string) => decisions.get(key(server, tool));
}
