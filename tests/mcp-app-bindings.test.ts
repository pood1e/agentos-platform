import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { RoleDefinitionSchema, ToolBindingSchema } from "../gen/agentos/console/v1/role_pb.js";
import { AgentTemplateSchema } from "../gen/kagent/api/v1/agent_templates_pb.js";
import {
  ListMCPAppToolsResponseSchema,
  MCPAppToolSchema,
  ToolServerSchema,
} from "../gen/kagent/api/v1/tools_pb.js";
import { appVisible } from "../server/kagent/tool-metadata.js";
import { mcpAppsEnvironment as setup } from "./fixtures/mcp-apps.js";
import { publishTargets, testBindings } from "./harness.js";

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

it("keeps existing App-only bindings when an Agent edits model-visible tools", async () => {
  const env = await setup();
  const server = "lab-views-inspection";
  env.fake.toolServers.push(
    create(ToolServerSchema, {
      ref: `agentos/${server}`,
      groupKind: "RemoteMCPServer.kagent.dev",
      discoveredTools: [],
    }),
  );
  publishTargets(env.fake, [
    {
      server,
      service: "lab-views",
      environment: "lab",
      project: "views",
      identity: "inspection",
      access: "write",
      catalog: false,
      tools: [
        { name: "show_topology", write: false, requireApproval: false },
        { name: "graph_data", write: false, requireApproval: false },
      ],
    },
  ]);
  const template = env.fake.templates.get("inspection");
  const spec = template?.resource?.value?.spec as {
    tools: { mcp: { server: { name: string }; tools: string[] } }[];
  };
  spec.tools.push({
    mcp: {
      server: { name: server },
      tools: ["lab-views_show_topology", "lab-views_graph_data"],
    },
  });
  const discover = env.clients.tools.listMCPAppTools.bind(env.clients.tools);
  vi.spyOn(env.clients.tools, "listMCPAppTools").mockImplementation((request, options) => {
    if (request.server?.ref?.name === server)
      throw new ConnectError("Profile tool metadata is unavailable", Code.Internal);
    return discover(request, options);
  });
  env.caller({ ...env.owner, capabilities: [Capability.AGENTS_MANAGE] });
  const config = await env.client.getConfiguration({});
  const role = config.roles.find((item) => item.name === "inspection");
  if (!role) throw new Error("inspection role missing");
  expect(role.tools.find((binding) => binding.server === server)?.tools).toEqual([
    "lab-views_show_topology",
  ]);
  const requirements = (await env.client.explainTools({ identity: "inspection" })).requirements;
  expect(requirements).toContainEqual(
    expect.objectContaining({ server, tool: "lab-views_show_topology" }),
  );
  expect(requirements).not.toContainEqual(
    expect.objectContaining({ server, tool: "lab-views_graph_data" }),
  );
  const invalid = clone(RoleDefinitionSchema, role);
  invalid.tools.find((binding) => binding.server === server)?.tools.push("lab-views_graph_data");
  await expect(env.client.updateRole({ role: invalid })).rejects.toMatchObject({
    code: Code.InvalidArgument,
    rawMessage: "configuration.invalidTools",
  });
  const updated = await env.client.updateRole({ role });
  expect(updated.role?.tools.find((binding) => binding.server === server)?.tools).toEqual([
    "lab-views_show_topology",
    "lab-views_graph_data",
  ]);
  const visible = (await env.client.getConfiguration({})).roles.find(
    (item) => item.name === "inspection",
  );
  expect(visible?.tools.find((binding) => binding.server === server)?.tools).toEqual([
    "lab-views_show_topology",
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
        labels: { "agentos.dev/identity": "assistant", "agentos.dev/tool-access": "write" },
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
      identity: "assistant",
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
