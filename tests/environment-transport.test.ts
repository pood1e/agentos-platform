import { connect, type IncomingHttpHeaders } from "node:http2";
import { create, toJsonString } from "@bufbuild/protobuf";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { McpRequestSchema } from "../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { environmentAuthorization } from "../server/authorization/transport.js";
import { grpcServer } from "../server/platform/grpc.js";

it("authenticates transport notifications, event streams and session cleanup over native h2c", async () => {
  const app = Fastify();
  const authorize = vi.fn(async () => "environment-token");
  const server = grpcServer(app, {
    routes: () => {},
    fallback: environmentAuthorization(authorize),
  });
  await server.listen(0, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("RPC address missing");
  const client = connect(`http://127.0.0.1:${address.port}`);
  const target = create(McpRequestSchema, {
    serviceNames: ["lab-kubernetes"],
    metadataContext: { environment: "lab", identity: "diagnosis", discovery: true },
  });
  async function request(method: string, body: string, path = "/authorize/environment") {
    return new Promise<IncomingHttpHeaders>((resolve, reject) => {
      const stream = client.request(
        { ":method": method, ":path": path, "x-substrate-actor-token": "Bearer actor-proof" },
        { endStream: false },
      );
      let headers: IncomingHttpHeaders;
      stream.on("response", (value) => {
        headers = value;
      });
      stream.on("data", () => {});
      stream.on("error", reject);
      stream.on("end", () => resolve(headers));
      stream.end(body);
    });
  }
  try {
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await request(method, toJsonString(McpRequestSchema, target));
      expect(response[":status"]).toBe(200);
      expect(response.authorization).toBe("Bearer environment-token");
      expect(authorize).toHaveBeenLastCalledWith(target, "Bearer actor-proof");
    }
    expect((await request("POST", "invalid"))[":status"]).toBe(403);
    expect((await request("POST", "{}", "/other"))[":status"]).toBe(404);
    authorize.mockRejectedValueOnce(new Error("revoked"));
    const denied = await request("POST", toJsonString(McpRequestSchema, target));
    expect(denied[":status"]).toBe(403);
    expect(denied.authorization).toBeUndefined();
  } finally {
    client.close();
    await app.close();
  }
});
