import { readFileSync } from "node:fs";
import { createServer } from "node:http2";
import { createClient } from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport } from "@connectrpc/connect-node";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import Fastify from "fastify";
import { createRemoteJWKSet } from "jose";
import { ExtMcp } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { Control } from "../../gen/ateapi_pb.js";
import {
  actorTokenHeader,
  actorVerifier,
  runtimeIdentity,
} from "../../server/authorization/actor.js";
import { mcpAuthorization } from "../../server/authorization/mcp.js";
import { kagentClients, kagentTransport } from "../../server/kagent/clients.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const workspace = required("PROOF_WORKSPACE");
const issuer = required("PROOF_ISSUER");
const substrate = createClient(
  Control,
  createGrpcTransport({
    baseUrl: required("PROOF_SUBSTRATE_URL"),
    nodeOptions: { ca: readFileSync(required("NODE_EXTRA_CA_CERTS")) },
    interceptors: [
      (next) => (request) => {
        request.header.set(
          "Authorization",
          `Bearer ${readFileSync(required("PROOF_TOKEN_FILE"), "utf8").trim()}`,
        );
        return next(request);
      },
    ],
  }),
);
const clients = kagentClients(
  kagentTransport({
    url: required("PROOF_KAGENT_URL"),
    namespace: workspace,
    userId: "authorization-proof",
  }),
);
const identity = runtimeIdentity(
  actorVerifier(
    createRemoteJWKSet(new URL("/openid/v1/jwks", issuer)),
    issuer,
    required("PROOF_AUDIENCE"),
  ),
  substrate,
  clients.sessions,
  workspace,
);
let acceptedCalls = 0;
let lastSessionId: string | undefined;
const checkedCalls: Array<{ sessionId: string; tool: string; resource: unknown }> = [];
const processor = createServer(
  connectNodeAdapter({
    routes: (router) =>
      router.service(
        ExtMcp,
        mcpAuthorization(identity, async (session, tool) => {
          const resource = tool.arguments?.resource;
          checkedCalls.push({ sessionId: session.id, tool: tool.name, resource });
          if (checkedCalls.length > 64) checkedCalls.shift();
          if (tool.name !== "inspect_identity" || resource !== "allowed")
            throw new Error("Resource is outside the proof scope");
        }),
      ),
  }),
);
const handler = toNodeHandler(
  createMcpHandler(({ authInfo }) => {
    const server = new McpServer({ name: "runtime-identity-proof", version: "1.0.0" });
    server.registerTool(
      "inspect_identity",
      {
        description: "Verify the current signed Actor identity and native Session binding.",
        inputSchema: fromJsonSchema<{ resource: string; nonce?: string }>({
          type: "object",
          properties: { resource: { type: "string" }, nonce: { type: "string" } },
          required: ["resource"],
        }),
      },
      async (args) => {
        if (!authInfo?.clientId || authInfo.clientId === "discovery")
          throw new Error("Runtime identity required");
        acceptedCalls++;
        lastSessionId = authInfo.clientId;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionId: authInfo.clientId,
                ...authInfo.extra,
                nonce: args.nonce,
              }),
            },
          ],
        };
      },
    );
    return server;
  }),
);
const app = Fastify({ logger: false });
app.get("/healthz", async () => ({ status: "ok" }));
app.get("/evidence", async () => ({ acceptedCalls, lastSessionId, checkedCalls }));
app.route({
  method: ["GET", "POST", "DELETE"],
  url: "/mcp",
  preHandler: async (request, reply) => {
    const body = request.body;
    if (Array.isArray(body)) return reply.code(400).send();
    if (body && typeof body === "object" && "method" in body && body.method === "tools/call") {
      const header = request.headers[actorTokenHeader];
      if (typeof header !== "string" || !/^Bearer [^\s,]+$/.test(header))
        return reply.code(401).send();
      const session = await identity(header.slice(7)).catch(() => undefined);
      if (!session) return reply.code(403).send();
      Object.assign(request.raw, {
        auth: {
          token: "",
          clientId: session.id,
          scopes: ["inspect_identity"],
          extra: { agent: session.agent?.name, creator: session.creator },
        },
      });
    } else {
      Object.assign(request.raw, { auth: { token: "", clientId: "discovery", scopes: [] } });
    }
  },
  handler: async (request, reply) => {
    reply.hijack();
    await handler(request.raw, reply.raw, request.body);
  },
});
app.addHook("onClose", async () => {
  await new Promise<void>((resolve) => processor.close(() => resolve()));
});
await app.listen({ host: "0.0.0.0", port: 8080 });
processor.listen(9090, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
