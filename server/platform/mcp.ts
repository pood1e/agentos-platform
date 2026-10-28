import { Code, ConnectError } from "@connectrpc/connect";
import type { FastifyInstance } from "fastify";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { can } from "../../shared/permissions.js";
import { userIdentity } from "../authorization/identity.js";
import type { serviceAccountTokens } from "../authorization/workloads.js";
import type { BindingView } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { registerTeamSessions } from "../team-sessions/app.js";
import { sessionTools } from "../team-sessions/tools.js";

const discovery = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "server/discover",
  "tools/list",
]);

export async function registerPlatformMcp(
  app: FastifyInstance,
  namespace: string,
  clients: KagentClients,
  access: BindingView,
  review: ReturnType<typeof serviceAccountTokens>,
  controllerSubject: string,
) {
  const identity = userIdentity(clients, "");
  await registerTeamSessions(
    app,
    sessionTools(clients, namespace, access),
    async (headers, method) => {
      const authorization = headers.authorization;
      if (typeof authorization !== "string")
        throw new ConnectError("Authentication required", Code.Unauthenticated);
      // Native egress supplies a verified initiator credential; the business API
      // forwards that credential, while gateway Actor proofs stay at the gateway.
      const native = new Headers({ authorization });
      try {
        const principal = await identity(native);
        if (!can(principal, Capability.AGENTS_MANAGE))
          throw new ConnectError("Permission denied", Code.PermissionDenied);
        return {
          clientId: principal.subject,
          scopes: ["list_role_tools", "prepare_role"],
          headers: native,
        };
      } catch (error) {
        if (!discovery.has(method) || ConnectError.from(error).code !== Code.Unauthenticated)
          throw error;
        const token = authorization.match(/^Bearer ([^\s,]+)$/)?.[1];
        if (!token) throw error;
        await review(token, "agentos-mcp-discovery", [controllerSubject]);
        return {
          clientId: controllerSubject,
          scopes: ["list_role_tools", "prepare_role"],
          headers: new Headers(),
        };
      }
    },
  );
}
