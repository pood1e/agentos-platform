import { create, fromJsonString, toJson } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError } from "@connectrpc/connect";
import type { FastifyInstance } from "fastify";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { ToolBindingSchema } from "../../gen/agentos/console/v1/role_pb.js";
import { AppReferenceSchema } from "../../gen/agentos/mcp/v1/app_pb.js";
import { nativeHeaders } from "../kagent/context.js";
import type { McpApps } from "./service.js";

const validator = createValidator();

/** Gateway extAuth authenticates the original viewer again; no caller headers grant selection. */
export function registerAppAuthorization(
  app: FastifyInstance,
  apps: McpApps,
  identity: (headers: Headers) => Promise<UserIdentity>,
) {
  app.route<{ Querystring: { server?: string } }>({
    method: ["POST", "GET", "DELETE"],
    url: "/authorize/mcp-app",
    handler: async (request, reply) => {
      reply.header("cache-control", "no-store");
      const bearer = request.headers.authorization;
      if (!bearer?.match(/^Bearer [^\s,]+$/)) return reply.code(401).send();
      const encoded = request.headers["x-agentos-app-reference"];
      const server = request.query.server;
      if (
        typeof encoded !== "string" ||
        encoded.length > 2048 ||
        !/^[A-Za-z0-9_-]+$/.test(encoded) ||
        typeof server !== "string" ||
        !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(server)
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
        const principal = await identity(headers);
        const selection = await nativeHeaders.run(headers, () =>
          apps.authorize(reference, principal, AbortSignal.timeout(15_000)),
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
