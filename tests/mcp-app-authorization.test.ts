import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { MessageSchema, Role, TaskState } from "../gen/a2a_pb.js";
import { AppReferenceSchema } from "../gen/agentos/mcp/v1/app_pb.js";
import { nativeSignal } from "../server/kagent/context.js";
import { object, partTypeKey } from "../server/read-model/decode/messages.js";
import { canonicalMcpAppsEnvironment as canonical } from "./fixtures/mcp-apps.js";
import { publishTargets } from "./harness.js";

it("authorizes canonical bindings without an Environment or an Agent-named connection", async () => {
  const env = await canonical();
  await expect(env.client.getAppResource(env.request)).resolves.toHaveProperty("result");
  await expect(
    env.client.callAppTool({ ...env.request, name: "graph_data" }),
  ).resolves.toHaveProperty("result");
  expect(env.invoke).toHaveBeenCalledWith(
    "http://gateway.test:8080",
    "lab-views",
    expect.objectContaining({
      taskId: env.request.app.taskId,
      callId: env.request.app.callId,
      workspace: expect.objectContaining(env.request.app.workspace),
    }),
    "latest-alice-token",
    { name: "lab-views_graph_data", arguments: undefined },
    expect.any(AbortSignal),
  );
});

it("rejects an App reference bound to another workspace identity", async () => {
  const env = await canonical();
  await expect(
    env.client.getAppResource({
      app: { ...env.request.app, workspace: { namespace: "agentos", uid: "old-uid" } },
    }),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

it("rejects a call from an earlier workspace incarnation", async () => {
  const env = await canonical();
  const session = env.fake.sessions.get(env.task.contextId);
  if (!session?.authority) throw new Error("Session authority fixture missing");
  session.authority.workspaceUid = "old-uid";
  await expect(env.client.getAppResource(env.request)).rejects.toMatchObject({
    code: Code.NotFound,
  });
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

it("propagates the App authorization deadline to every native RPC", async () => {
  const env = await canonical();
  const controller = new AbortController();
  controller.abort();
  await expect(
    nativeSignal.run(controller.signal, () => env.clients.system.getCurrentUser({})),
  ).rejects.toMatchObject({ code: Code.Canceled });
  expect(nativeSignal.getStore()).toBeUndefined();
});
