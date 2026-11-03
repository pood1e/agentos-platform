import { create, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import Fastify from "fastify";
import { expect, it, onTestFinished, vi } from "vitest";
import { AppReferenceSchema } from "../gen/agentos/mcp/v1/app_pb.js";
import { nativeHeaders } from "../server/kagent/context.js";
import { registerAppAuthorization } from "../server/mcp-apps/http.js";
import { canonicalMcpAppsEnvironment as canonical } from "./fixtures/mcp-apps.js";
import { allowWorkspace } from "./workspace-member.js";

async function authority() {
  const env = await canonical();
  const app = Fastify();
  onTestFinished(() => app.close());
  const identity = vi.fn(async (headers: Headers) => {
    if (headers.get("authorization") !== "Bearer current-viewer")
      throw new ConnectError("Invalid token", Code.Unauthenticated);
    expect([...headers.keys()]).toEqual(["authorization"]);
    return env.owner;
  });
  const authorize = vi.spyOn(env.apps, "authorize");
  registerAppAuthorization(app, (namespace) =>
    namespace === "agentos"
      ? { apps: env.apps, identity, member: allowWorkspace("agentos") }
      : undefined,
  );
  const headers = {
    authorization: "Bearer current-viewer",
    "x-agentos-app-reference": Buffer.from(
      toJsonString(AppReferenceSchema, create(AppReferenceSchema, env.request.app)),
    ).toString("base64url"),
  };
  return { ...env, app, identity, authorize, headers };
}

it("derives gateway selection from native bindings and ignores forged authorization headers", async () => {
  const env = await authority();
  const getSession = vi.mocked(env.clients.sessions.getSession).getMockImplementation();
  if (!getSession) throw new Error("Native ownership fixture missing");
  vi.spyOn(env.clients.sessions, "getSession").mockImplementation((...args) => {
    expect([...(nativeHeaders.getStore()?.keys() ?? [])]).toEqual(["authorization"]);
    return getSession(...args);
  });
  const response = await env.app.inject({
    method: "POST",
    url: "/authorize/mcp-app?server=lab-views&workspace=agentos",
    headers: {
      ...env.headers,
      "x-substrate-actor-token": "forged",
      "x-agentos-selection": '{"tools":["destroy"]}',
    },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual({
    selection: { server: "lab-views", tools: ["lab-views_show_topology", "lab-views_graph_data"] },
  });
  expect(env.identity).toHaveBeenCalledOnce();
});

it("denies gateway callbacks after workspace recreation", async () => {
  const env = await authority();
  const reference = create(AppReferenceSchema, {
    ...env.request.app,
    workspace: { namespace: "agentos", uid: "old-uid" },
  });
  const response = await env.app.inject({
    method: "POST",
    url: "/authorize/mcp-app?server=lab-views&workspace=agentos",
    headers: {
      ...env.headers,
      "x-agentos-app-reference": Buffer.from(toJsonString(AppReferenceSchema, reference)).toString(
        "base64url",
      ),
    },
  });
  expect(response.statusCode).toBe(403);
  expect(env.authorize).not.toHaveBeenCalled();
});

it("binds App authorization to the gateway workspace, not the caller's reference", async () => {
  const env = await authority();
  const foreign = create(AppReferenceSchema, {
    ...env.request.app,
    workspace: { namespace: "operations", uid: "operations-uid" },
  });
  const response = await env.app.inject({
    method: "POST",
    url: "/authorize/mcp-app?server=lab-views&workspace=agentos",
    headers: {
      ...env.headers,
      "x-agentos-app-reference": Buffer.from(toJsonString(AppReferenceSchema, foreign)).toString(
        "base64url",
      ),
    },
  });
  expect(response.statusCode).toBe(403);
  expect(env.identity).not.toHaveBeenCalled();
  expect(env.authorize).not.toHaveBeenCalled();
});

it("rejects an App callback without a gateway workspace", async () => {
  const env = await authority();
  const response = await env.app.inject({
    method: "POST",
    url: "/authorize/mcp-app?server=lab-views",
    headers: env.headers,
  });
  expect(response.statusCode).toBe(403);
  expect(env.authorize).not.toHaveBeenCalled();
});

it.each([
  ["missing bearer", { authorization: "" }, "lab-views", 401],
  ["invalid bearer", { authorization: "Bearer invalid" }, "lab-views", 401],
  [
    "forged reference",
    {
      "x-agentos-app-reference": Buffer.from('{"taskId":"other","callId":"app-call"}').toString(
        "base64url",
      ),
    },
    "lab-views",
    403,
  ],
  ["invalid encoding", { "x-agentos-app-reference": "%%%" }, "lab-views", 403],
  ["different backend", {}, "other-backend", 403],
] as const)("gateway authority rejects %s", async (_name, changed, server, status) => {
  const env = await authority();
  const response = await env.app.inject({
    method: "POST",
    url: `/authorize/mcp-app?server=${server}&workspace=agentos`,
    headers: { ...env.headers, ...changed },
  });
  expect(response.statusCode).toBe(status);
  expect(env.invoke).not.toHaveBeenCalled();
});

it.each(["GET", "DELETE"] as const)(
  "reauthorizes SDK %s transport lifecycle requests",
  async (method) => {
    const env = await authority();
    const response = await env.app.inject({
      method,
      url: "/authorize/mcp-app?server=lab-views&workspace=agentos",
      headers: env.headers,
    });
    expect(response.statusCode).toBe(200);
    env.fake.renewable = false;
    const revoked = await env.app.inject({
      method,
      url: "/authorize/mcp-app?server=lab-views&workspace=agentos",
      headers: env.headers,
    });
    expect(revoked.statusCode).toBe(403);
  },
);
