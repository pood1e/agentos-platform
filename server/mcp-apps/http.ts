import { create, fromJsonString, toJson } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError } from "@connectrpc/connect";
import type { FastifyInstance } from "fastify";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { ToolBindingSchema } from "../../gen/agentos/console/v1/role_pb.js";
import { AppReferenceSchema } from "../../gen/agentos/mcp/v1/app_pb.js";
import type { WorkspaceMember } from "../authorization/workspaces.js";
import { bearerToken, nativeHeaders, nativeSignal } from "../kagent/context.js";
import type { McpApps } from "./service.js";

const validator = createValidator();
const dnsLabel = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Gateway extAuth authenticates the original viewer again; no caller headers grant selection. */
export function registerAppAuthorization(
  app: FastifyInstance,
  target: (namespace: string) =>
    | {
        apps: McpApps;
        identity: (headers: Headers) => Promise<UserIdentity>;
        member: WorkspaceMember;
      }
    | undefined,
) {
  app.route<{ Querystring: { server?: string; workspace?: string } }>({
    method: ["POST", "GET", "DELETE"],
    url: "/authorize/mcp-app",
    handler: async (request, reply) => {
      reply.header("cache-control", "no-store");
      const bearer = request.headers.authorization;
      if (!bearer || !bearerToken(bearer)) return reply.code(401).send();
      const encoded = request.headers["x-agentos-app-reference"];
      const server = request.query.server;
      const gatewayWorkspace = request.query.workspace;
      if (
        typeof encoded !== "string" ||
        encoded.length > 2048 ||
        !/^[A-Za-z0-9_-]+$/.test(encoded) ||
        typeof server !== "string" ||
        !dnsLabel.test(server) ||
        typeof gatewayWorkspace !== "string" ||
        !dnsLabel.test(gatewayWorkspace)
      )
        return reply.code(403).send();
      const headers = new Headers({ authorization: bearer });
      try {
        const reference = fromJsonString(
          AppReferenceSchema,
          Buffer.from(encoded, "base64url").toString("utf8"),
        );
        if (validator.validate(AppReferenceSchema, reference).kind !== "valid")
          return reply.code(403).send();
        const workspace = reference.workspace;
        if (workspace?.namespace !== gatewayWorkspace) return reply.code(403).send();
        const selected = target(gatewayWorkspace);
        if (!workspace?.uid || !selected) return reply.code(403).send();
        const signal = AbortSignal.timeout(10_000);
        const selection = await nativeSignal.run(signal, () =>
          nativeHeaders.run(headers, async () => {
            const member = await selected.member(headers, signal, workspace.uid);
            if (member.namespace !== workspace.namespace || member.uid !== workspace.uid)
              throw new ConnectError("Workspace access denied", Code.PermissionDenied);
            const principal = await selected.identity(headers);
            return selected.apps.authorize(reference, principal, signal);
          }),
        );
        if (selection.server !== server) return reply.code(403).send();
        return { selection: toJson(ToolBindingSchema, create(ToolBindingSchema, selection)) };
      } catch (error) {
        return reply
          .code(ConnectError.from(error).code === Code.Unauthenticated ? 401 : 403)
          .send();
      }
    },
  });
}
