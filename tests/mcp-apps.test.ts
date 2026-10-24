import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { AgentTemplateSchema } from "../gen/kagent/api/v1/agent_templates_pb.js";
import { MCPAppToolSchema } from "../gen/kagent/api/v1/tools_pb.js";
import { appVisible } from "../server/kagent/tool-metadata.js";
import { mcpAppsEnvironment as setup } from "./fixtures/mcp-apps.js";

it("projects an App from native metadata and reads only the original call's resource", async () => {
  const env = await setup();
  const controller = new AbortController();
  try {
    for await (const { conversation } of env.client.watchConversation(
      { agent: env.session.agent, contextId: env.session.id },
      { signal: controller.signal },
    )) {
      const part = conversation?.messages
        .flatMap((message) => message.parts)
        .find((part) => part.content.case === "toolCall");
      expect(part?.content.case === "toolCall" && part.content.value.uiResourceUri).toBe(
        "ui://lab-views/topology.html",
      );
      break;
    }
  } finally {
    controller.abort();
  }
  const result = await env.client.getAppResource(env.request);
  expect(result.sandboxOrigin).toBe("https://sandbox.example");
  expect(result.result?.value?.contents).toEqual([
    expect.objectContaining({
      mimeType: "text/html;profile=mcp-app",
      text: expect.stringContaining("Topology App"),
    }),
  ]);
  await expect(
    env.client.getAppResource({ ...env.request, callId: "forged-call" }),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

it("calls only same-service app-visible read tools as the current viewer and original Agent identity", async () => {
  const env = await setup();
  expect(
    (
      await env.client.callAppTool({
        ...env.request,
        name: "graph_data",
        arguments: { value: { focus: "router-1", identity: "admin" } },
      })
    ).result?.value?.structuredContent,
  ).toEqual({ devices: 12 });
  expect(env.token).toHaveBeenCalledExactlyOnceWith("lab", "assistant", env.owner);
  expect(env.invoke).toHaveBeenCalledWith(
    expect.anything(),
    "assistant",
    "views",
    "delegated-alice-token",
    { name: "graph_data", arguments: { focus: "router-1", identity: "admin" } },
    expect.any(AbortSignal),
  );
});

it.each(["destroy", "model_only", "other-service_graph_data", "unclassified", "missing"])(
  "rejects forbidden App tool %s before credential exchange",
  async (name) => {
    const env = await setup();
    await expect(env.client.callAppTool({ ...env.request, name })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    expect(env.token).not.toHaveBeenCalled();
    expect(env.invoke).not.toHaveBeenCalled();
  },
);

it("isolates both resource reads and tool calls from another user", async () => {
  const env = await setup();
  env.caller({ ...env.owner, subject: "bob", write: true });
  await expect(env.client.getAppResource(env.request)).rejects.toMatchObject({
    code: Code.NotFound,
  });
  await expect(
    env.client.callAppTool({ ...env.request, name: "graph_data" }),
  ).rejects.toMatchObject({ code: Code.NotFound });
  expect(env.token).not.toHaveBeenCalled();
});

it("hides app-only tools from role binding and identifies them for Actor authorization", async () => {
  const env = await setup();
  const servers = await env.metadata.modelServers(env.fake.toolServers);
  expect(
    servers
      .find((server) => server.ref === "agentos/lab-views")
      ?.discoveredTools.map((tool) => tool.name),
  ).toEqual(["lab-views_show_topology", "lab-views_model_only"]);
  expect(await env.metadata.appOnlyCall(["lab-views"], "lab-views_graph_data", "agentos")).toBe(
    true,
  );
  expect(await env.metadata.appOnlyCall(["lab-views"], "show_topology", "agentos")).toBe(false);
  env.caller({ ...env.owner, capabilities: [Capability.AGENTS_MANAGE] });
  await expect(
    env.client.createRole({
      role: {
        name: "app-reader",
        displayName: "App reader",
        systemPrompt: "Read graph data",
        tools: [{ server: "lab-views", tools: ["lab-views_graph_data"] }],
      },
    }),
  ).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: "configuration.invalidTools" });
});

it("disables view resources and callbacks when no sandbox is configured", async () => {
  const env = await setup("");
  await expect(env.client.getAppResource(env.request)).rejects.toMatchObject({
    code: Code.Unavailable,
  });
  await expect(
    env.client.callAppTool({ ...env.request, name: "graph_data" }),
  ).rejects.toMatchObject({ code: Code.Unavailable });
  expect(env.token).not.toHaveBeenCalled();
});

it("fails closed for invalid visibility and missing Actor metadata", async () => {
  expect(
    appVisible(create(MCPAppToolSchema, { meta: { value: { ui: { visibility: ["unknown"] } } } })),
  ).toBe(false);
  expect(appVisible(create(MCPAppToolSchema))).toBe(true);
  const env = await setup();
  await expect(
    env.metadata.appOnlyCall(["missing"], "graph_data", "agentos"),
  ).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  await expect(env.metadata.appOnlyCall(["lab-views"], "unknown", "agentos")).rejects.toMatchObject(
    {
      code: Code.PermissionDenied,
    },
  );
});

it("projects only model-visible bindings from native presets without losing normal or unknown selections", async () => {
  const env = await setup();
  env.fake.templates.set(
    "preset-reader",
    create(AgentTemplateSchema, {
      ref: { namespace: "agentos", name: "preset-reader" },
      resource: {
        value: {
          metadata: { name: "preset-reader" },
          spec: {
            systemPrompt: "Read views",
            tools: [
              {
                mcp: {
                  server: { name: "lab-views", kind: "RemoteMCPServer" },
                  tools: ["lab-views_show_topology", "lab-views_graph_data", "unavailable_tool"],
                },
              },
            ],
          },
        },
      },
    }),
  );
  const config = await env.client.getConfiguration({});
  expect(config.roles.find((role) => role.name === "preset-reader")?.tools[0]?.tools).toEqual([
    "lab-views_show_topology",
    "unavailable_tool",
  ]);
});
