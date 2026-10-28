import { clone, create, fromJson, type JsonObject, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { ArtifactSchema, TaskState } from "../gen/a2a_pb.js";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { ToolBindingSchema } from "../gen/agentos/console/v1/role_pb.js";
import { AgentTemplateSchema } from "../gen/kagent/api/v1/agent_templates_pb.js";
import {
  ListMCPAppToolsResponseSchema,
  MCPAppToolSchema,
  ToolServerSchema,
} from "../gen/kagent/api/v1/tools_pb.js";
import { appVisible } from "../server/kagent/tool-metadata.js";
import { mcpAppsEnvironment as setup } from "./fixtures/mcp-apps.js";
import { publishTargets, testBindings } from "./harness.js";

it("retains independent App instances when later calls share the same resource", async () => {
  const env = await setup();
  const artifact = env.task.artifacts[0];
  if (!artifact) throw new Error("App fixture missing");
  for (const id of ["revision-2", "revision-3"]) {
    const revision = clone(ArtifactSchema, artifact);
    revision.artifactId = id;
    for (const part of revision.parts) {
      if (part.content.case !== "data") continue;
      const value = toJson(ValueSchema, part.content.value) as JsonObject;
      value.id = id;
      part.content.value = fromJson(ValueSchema, value);
    }
    env.task.artifacts.push(revision);
  }
  env.fake.update(env.task, TaskState.COMPLETED);
  const controller = new AbortController();
  try {
    for await (const { conversation } of env.client.watchConversation(
      { agent: env.session.agent, contextId: env.session.id },
      { signal: controller.signal },
    )) {
      const calls =
        conversation?.messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.content.case === "toolCall" ? [part.content.value] : [],
          ),
        ) ?? [];
      expect(calls).toHaveLength(3);
      expect(calls.filter((call) => call.uiResourceUri).map((call) => call.id)).toEqual([
        env.callId,
        "revision-2",
        "revision-3",
      ]);
      break;
    }
  } finally {
    controller.abort();
  }
  await expect(env.client.getAppResource(env.request)).resolves.toHaveProperty("result");
});

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
    env.client.getAppResource({
      app: { ...env.request.app, callId: "forged-call" },
    }),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

it("reports discovery outages separately from empty tool sets and permits recovery", async () => {
  const env = await setup();
  const servers = (await env.clients.tools.listToolServers({})).toolServers;
  const discover = vi.spyOn(env.clients.tools, "listMCPAppTools");
  discover.mockRejectedValueOnce(new ConnectError("MCP unavailable", Code.Unavailable));
  await expect(env.metadata.modelServers(servers.slice(0, 1))).rejects.toMatchObject({
    code: Code.Unavailable,
  });
  const result = await env.metadata.modelServers(servers.slice(0, 1));
  expect(result[0]?.discoveredTools.length).toBeGreaterThan(0);
  expect(discover).toHaveBeenCalledTimes(2);
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
  expect(
    await env.metadata.appOnlyCalls(
      [{ server: "lab-views", tool: "lab-views_graph_data" }],
      "agentos",
    ),
  ).toBe(true);
  expect(
    await env.metadata.appOnlyCalls(
      [{ server: "lab-views", tool: "lab-views_show_topology" }],
      "agentos",
    ),
  ).toBe(false);
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
    env.metadata.appOnlyCalls([{ server: "missing", tool: "graph_data" }], "agentos"),
  ).rejects.toMatchObject({
    code: Code.Unavailable,
  });
  await expect(
    env.metadata.appOnlyCalls([{ server: "lab-views", tool: "unknown" }], "agentos"),
  ).rejects.toMatchObject({
    code: Code.Unavailable,
  });
});

it.each(["listToolServers", "listMCPAppTools"] as const)(
  "does not confuse a %s discovery authentication failure with a user's execution ceiling",
  async (method) => {
    const env = await setup();
    const request = [{ server: "lab-views", tool: "lab-views_show_topology" }];
    vi.spyOn(env.clients.tools, method).mockRejectedValueOnce(
      new ConnectError("Discovery credential is unavailable", Code.PermissionDenied),
    );
    await expect(env.metadata.appOnlyCalls(request, "agentos")).rejects.toMatchObject({
      code: Code.Unavailable,
    });
    expect(await env.metadata.appOnlyCalls(request, "agentos")).toBe(false);
  },
);

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

it("checks write visibility against the selected profile instead of the read-only catalog", async () => {
  const env = await setup();
  const profile = "lab-views-assistant-write";
  const write = "lab-views_update";
  const hidden = "lab-views_hidden_write";
  const server = create(ToolServerSchema, {
    ref: `agentos/${profile}`,
    groupKind: "RemoteMCPServer.kagent.dev",
    discoveredTools: [{ name: write }, { name: hidden }],
  });
  env.fake.toolServers.push(server);
  env.fake.resources.save(
    "agentgatewaybackends",
    {
      metadata: {
        name: profile,
        labels: { "agentos.dev/engineer": "assistant", "agentos.dev/tool-access": "write" },
      },
      spec: { mcp: { targets: [{ name: "lab-views" }] } },
    },
    true,
  );
  const original = env.clients.tools.listMCPAppTools.bind(env.clients.tools);
  vi.spyOn(env.clients.tools, "listMCPAppTools").mockImplementation((request, options) =>
    request.server?.ref?.name === profile
      ? Promise.resolve(
          create(ListMCPAppToolsResponseSchema, {
            tools: [
              { name: write },
              { name: hidden, meta: { value: { ui: { visibility: ["app"] } } } },
            ],
          }),
        )
      : original(request, options),
  );
  publishTargets(env.fake, [
    {
      server: profile,
      service: "lab-views",
      environment: "lab",
      project: "views",
      engineer: "assistant",
      access: "write",
      catalog: false,
      tools: [
        { name: "update", write: true, requireApproval: true },
        { name: "hidden_write", write: true, requireApproval: true },
      ],
    },
  ]);
  const bindings = await testBindings(env.fake)();
  const selected = [create(ToolBindingSchema, { server: profile, tools: [write, hidden] })];
  const references = bindings.environmentCalls(selected, "update", ["lab-views"]);
  expect(references).toEqual([{ server: profile, tool: write }]);
  expect(bindings.environmentCalls(selected, "update", ["other-service"])).toEqual([]);
  expect(bindings.environmentCalls(selected, "lab-views_update")).toEqual(references);
  expect(await env.metadata.appOnlyCalls(references, "agentos")).toBe(false);
  expect(
    await env.metadata.appOnlyCalls(bindings.environmentCalls(selected, hidden), "agentos"),
  ).toBe(true);
  expect(bindings.catalogServer(server, env.fake.toolServers)).toBe(server);
  const visible = await env.metadata.modelServers([server], (item) =>
    bindings.catalogServer(item, env.fake.toolServers),
  );
  expect(visible[0]?.discoveredTools.map((tool) => tool.name)).toEqual([write]);
});
