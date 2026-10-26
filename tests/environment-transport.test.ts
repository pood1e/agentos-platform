import { connect, type IncomingHttpHeaders } from "node:http2";
import { create, fromJson, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AuthenticationV1Api } from "@kubernetes/client-node";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { McpRequestSchema } from "../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { WorkloadAuthenticationSchema } from "../gen/agentos/authorization/v1/workload_pb.js";
import { gatewayAuthorization } from "../server/authorization/transport.js";
import { workloadIdentity } from "../server/authorization/workloads.js";
import { grpcServer } from "../server/platform/grpc.js";

it("authenticates transport notifications, event streams and session cleanup over native h2c", async () => {
  const app = Fastify();
  const authorize = vi.fn(async () => "environment-token");
  const server = grpcServer(app, {
    routes: () => {},
    fallback: gatewayAuthorization(authorize, async () => {}, {
      automation: async () => {
        throw new Error("not configured");
      },
    } as unknown as import("../server/authorization/workloads.js").WorkloadIdentity),
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
    expect((await request("POST", "invalid"))[":status"]).toBe(400);
    expect((await request("POST", "{}", "/other"))[":status"]).toBe(404);
    authorize.mockRejectedValueOnce(new ConnectError("revoked", Code.PermissionDenied));
    const denied = await request("POST", toJsonString(McpRequestSchema, target));
    expect(denied[":status"]).toBe(403);
    expect(denied.authorization).toBeUndefined();
    for (const [code, status] of [
      [Code.Unavailable, 503],
      [Code.DeadlineExceeded, 504],
      [Code.Unauthenticated, 401],
    ]) {
      authorize.mockRejectedValueOnce(new ConnectError("upstream", code));
      expect((await request("POST", toJsonString(McpRequestSchema, target)))[":status"]).toBe(
        status,
      );
    }
  } finally {
    client.close();
    await app.close();
  }
});

it("validates discovery with TokenReview on the private h2c endpoint", async () => {
  const app = Fastify();
  const authorize = vi.fn(async () => "environment-token");
  const review = vi.fn<AuthenticationV1Api["createTokenReview"]>(async ({ body }) => ({
    spec: body.spec,
    status: {
      authenticated: true,
      audiences: ["agentos-mcp-discovery"],
      user: { username: "system:serviceaccount:agentos:kagent" },
    },
  }));
  const workloads = workloadIdentity(
    fromJson(WorkloadAuthenticationSchema, {
      controllerSubject: "system:serviceaccount:agentos:kagent",
      platformSubject: "system:serviceaccount:agentos:console",
      modelAudience: "models",
      mcpAudience: "tools",
    }),
    { createTokenReview: review },
  );
  const server = grpcServer(app, {
    routes: () => {},
    fallback: gatewayAuthorization(authorize, async () => {}, workloads),
  });
  await server.listen(0, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("RPC address missing");
  const client = connect(`http://127.0.0.1:${address.port}`);
  const request = (path: string, method = "GET", authorization?: string) =>
    new Promise<{ headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const stream = client.request(
        { ":path": path, ":method": method, ...(authorization ? { authorization } : {}) },
        { endStream: false },
      );
      let headers: IncomingHttpHeaders;
      const data: Buffer[] = [];
      stream.on("response", (value) => {
        headers = value;
      });
      stream.on("data", (value) => data.push(Buffer.from(value)));
      stream.on("error", reject);
      stream.on("end", () => resolve({ headers, body: Buffer.concat(data).toString() }));
      stream.end(
        path === "/authorize/environment" ? '{"metadataContext":{"discovery":true}}' : undefined,
      );
    });
  try {
    expect((await request("/authorize/environment", "POST")).headers[":status"]).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(
      (await request("/authorize/environment", "POST", "Bearer controller")).headers[":status"],
    ).toBe(200);
    expect(review).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          spec: { token: "controller", audiences: ["agentos-mcp-discovery"] },
        }),
      }),
      expect.anything(),
    );
    review.mockResolvedValueOnce({
      spec: { token: "deleted-pod" },
      status: { authenticated: false, audiences: [], user: { username: "" } },
    });
    expect(
      (await request("/authorize/environment", "POST", "Bearer deleted-pod")).headers[":status"],
    ).toBe(401);
    expect(authorize).toHaveBeenCalledOnce();
  } finally {
    client.close();
    await app.close();
  }
});
