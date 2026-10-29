import { create, fromJson, toJsonString } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import Fastify from "fastify";
import { expect, it, onTestFinished, vi } from "vitest";
import { MessageSchema, Role, TaskState } from "../gen/a2a_pb.js";
import { AppReferenceSchema } from "../gen/agentos/mcp/v1/app_pb.js";
import { nativeHeaders } from "../server/kagent/context.js";
import { registerAppAuthorization } from "../server/mcp-apps/http.js";
import { object, partTypeKey } from "../server/read-model/decode/messages.js";
import { mcpAppsEnvironment as setup } from "./fixtures/mcp-apps.js";
import { publishTargets } from "./harness.js";

async function canonical() {
  const env = await setup();
  publishTargets(env.fake, [
    {
      server: "lab-views",
      service: "lab-views",
      catalog: true,
      access: "readOnly",
      tools: [
        { name: "show_topology", write: false, requireApproval: false },
        { name: "graph_data", write: false, requireApproval: false },
        { name: "destroy", write: true, requireApproval: true },
      ],
    },
  ]);
  const template = env.fake.templates.get("assistant");
  const spec = template?.resource?.value?.spec as {
    tools: { mcp: { server: { name: string }; tools: string[] } }[];
  };
  spec.tools[0].mcp.server.name = "lab-views";
  return { ...env, binding: spec.tools[0].mcp };
}

it("authorizes canonical bindings without an Environment or an engineer-named connection", async () => {
  const env = await canonical();
  await expect(env.client.getAppResource(env.request)).resolves.toHaveProperty("result");
  await expect(
    env.client.callAppTool({ ...env.request, name: "graph_data" }),
  ).resolves.toHaveProperty("result");
  expect(env.invoke).toHaveBeenCalledWith(
    "http://gateway.test:8080",
    "lab-views",
    expect.objectContaining(env.request.app),
    "latest-alice-token",
    { name: "lab-views_graph_data", arguments: undefined },
    expect.any(AbortSignal),
  );
});

it.each(["origin", "callback", "revoked", "policy"])(
  "rechecks %s authorization after a resource cache hit",
  async (change) => {
    const env = await canonical();
    const read = vi.spyOn(env.clients.tools, "readMCPAppResource");
    await env.client.getAppResource(env.request);
    if (change === "origin") env.binding.tools = ["lab-views_graph_data"];
    if (change === "callback") env.binding.tools = ["lab-views_show_topology"];
    if (change === "revoked") env.fake.renewable = false;
    if (change === "policy")
      publishTargets(env.fake, [
        {
          server: "lab-views",
          service: "lab-views",
          catalog: true,
          access: "readOnly",
          tools: [],
        },
      ]);
    await expect(
      env.client.callAppTool({ ...env.request, name: "graph_data" }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    if (change !== "callback")
      await expect(env.client.getAppResource(env.request)).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
    expect(read).toHaveBeenCalledOnce();
    expect(env.invoke).not.toHaveBeenCalled();
  },
);

it("requires both the original and app-only tool in the same actual binding", async () => {
  const env = await canonical();
  env.binding.tools = ["lab-views_show_topology", "lab-views_destroy"];
  await expect(env.client.callAppTool({ ...env.request, name: "destroy" })).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  env.binding.server.name = "another-service";
  await expect(env.client.getAppResource(env.request)).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
});

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
  registerAppAuthorization(app, env.apps, identity);
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
    url: "/authorize/mcp-app?server=lab-views",
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
    url: `/authorize/mcp-app?server=${server}`,
    headers: { ...env.headers, ...changed },
  });
  expect(response.statusCode).toBe(status);
  expect(env.invoke).not.toHaveBeenCalled();
});

it("does not allow administrators to substitute another task's initiator", async () => {
  const env = await canonical();
  const identity = { ...env.owner, subject: "other-admin", write: true };
  await expect(
    env.apps.authorize(
      create(AppReferenceSchema, env.request.app),
      identity,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

it("resolves an inline native Agent template without inventing a role identity", async () => {
  const env = await canonical();
  const agent = env.fake.agents.find(
    (agent) => agent.ref?.namespace === "agentos" && agent.ref.name === "assistant",
  );
  if (!agent?.resource?.value) throw new Error("Agent fixture missing");
  const template = env.fake.templates.get("assistant");
  object(agent.resource.value.spec).template = { inline: object(template?.resource?.value?.spec) };
  await expect(
    env.client.callAppTool({ ...env.request, name: "graph_data" }),
  ).resolves.toHaveProperty("result");
});

it.each(["GET", "DELETE"] as const)(
  "reauthorizes SDK %s transport lifecycle requests",
  async (method) => {
    const env = await authority();
    const response = await env.app.inject({
      method,
      url: "/authorize/mcp-app?server=lab-views",
      headers: env.headers,
    });
    expect(response.statusCode).toBe(200);
    env.fake.renewable = false;
    const revoked = await env.app.inject({
      method,
      url: "/authorize/mcp-app?server=lab-views",
      headers: env.headers,
    });
    expect(revoked.statusCode).toBe(403);
  },
);

it.each([Role.USER, Role.UNSPECIFIED])(
  "rejects caller-authored tool events from role %s, including collisions with cached real calls",
  async (role) => {
    for (const collide of [false, true]) {
      const env = await canonical();
      await env.client.getAppResource(env.request);
      const callId = collide ? env.callId : "forged-call";
      env.task.history.push(
        create(MessageSchema, {
          messageId: "forged-message",
          role,
          parts: [
            {
              metadata: { [partTypeKey]: "function_call" },
              content: {
                case: "data",
                value: fromJson(ValueSchema, {
                  id: callId,
                  name: "lab-views_show_topology",
                  args: { focus: "forged" },
                }),
              },
            },
          ],
        }),
      );
      env.fake.update(env.task, TaskState.COMPLETED);
      const request = { app: { ...env.request.app, callId } };
      await expect(env.client.getAppResource(request)).rejects.toMatchObject({
        code: Code.NotFound,
      });
      await expect(
        env.client.callAppTool({ ...request, name: "graph_data" }),
      ).rejects.toMatchObject({ code: Code.NotFound });
      expect(env.invoke).not.toHaveBeenCalled();
      if (!collide)
        await expect(env.client.getAppResource(env.request)).resolves.toHaveProperty("result");
    }
  },
);
