import { clone, create, fromJson, type JsonObject, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { ArtifactSchema, TaskState } from "../gen/a2a_pb.js";
import { ToolServerSchema } from "../gen/kagent/api/v1/tools_pb.js";
import { mcpAppsEnvironment as setup } from "./fixtures/mcp-apps.js";

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

it.each(["lab-views-assistant", "lab-views-assistant-approval"])(
  "resolves structured MCP activity from %s to the selected Agent connection",
  async (server) => {
    const env = await setup();
    for (const part of env.task.artifacts[0].parts) {
      if (part.content.case !== "data") continue;
      const activity = toJson(ValueSchema, part.content.value) as JsonObject;
      activity.name = "show_topology";
      activity.mcp_server = server;
      part.content.value = fromJson(ValueSchema, activity);
    }
    env.fake.update(env.task, TaskState.COMPLETED);
    await expect(env.client.getAppResource(env.request)).resolves.toHaveProperty("result");
    await env.client.callAppTool({ ...env.request, name: "graph_data" });
    expect(env.invoke).toHaveBeenCalledWith(
      "http://gateway.test:8080",
      "lab-views-assistant",
      expect.objectContaining({
        taskId: env.request.app.taskId,
        callId: env.request.app.callId,
        workspace: expect.objectContaining(env.request.app.workspace),
      }),
      "latest-alice-token",
      { name: "lab-views_graph_data", arguments: undefined },
      expect.any(AbortSignal),
    );
  },
);

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

it("keeps actor-only servers without querying their unavailable global metadata", async () => {
  const env = await setup();
  const discover = vi.spyOn(env.clients.tools, "listMCPAppTools");
  const server = create(ToolServerSchema, {
    ref: "agentos/lab-views-assistant",
    groupKind: "RemoteMCPServer.api.kagent.dev",
    discoveredTools: [],
  });
  expect(await env.metadata.modelServers([server])).toEqual([server]);
  expect(discover).not.toHaveBeenCalled();
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
  expect(env.invoke).toHaveBeenCalledWith(
    "http://gateway.test:8080",
    "lab-views-assistant",
    expect.objectContaining({
      taskId: env.request.app.taskId,
      callId: env.request.app.callId,
      workspace: expect.objectContaining(env.request.app.workspace),
    }),
    "latest-alice-token",
    { name: "lab-views_graph_data", arguments: { focus: "router-1", identity: "admin" } },
    expect.any(AbortSignal),
  );
});

it.each(["destroy", "model_only", "other-service_graph_data", "unclassified", "missing"])(
  "rejects forbidden App tool %s before gateway access",
  async (name) => {
    const env = await setup();
    await expect(env.client.callAppTool({ ...env.request, name })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    expect(env.invoke).not.toHaveBeenCalled();
  },
);

it("requires the current viewer's credential before calling the gateway", async () => {
  const env = await setup();
  env.bearer("");
  await expect(
    env.client.callAppTool({ ...env.request, name: "graph_data" }),
  ).rejects.toMatchObject({ code: Code.Unauthenticated });
  expect(env.invoke).not.toHaveBeenCalled();
});

it("isolates both resource reads and tool calls from another user", async () => {
  const env = await setup();
  env.caller({ ...env.owner, subject: "bob", write: true });
  await expect(env.client.getAppResource(env.request)).rejects.toMatchObject({
    code: Code.NotFound,
  });
  await expect(
    env.client.callAppTool({ ...env.request, name: "graph_data" }),
  ).rejects.toMatchObject({ code: Code.NotFound });
});
