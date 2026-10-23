import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { ConnectionKind, ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { workspaceContext } from "../server/platform/access.js";
import { allCapabilities, capabilityRole, roleCapabilities } from "../shared/permissions.js";

it("enforces each resource permission independently at every public mutation", async () => {
  const principal = create(ExecutionIdentitySchema, { subject: "user:alice", write: true });
  const transport = createRouterTransport(
    (router) => {
      router.service(ConsoleService, {
        createRole: () => ({}),
        updateRole: () => ({}),
        sendMessage: () => ({}),
        cancelTask: () => ({}),
        updateTaskTags: () => ({}),
        respondInteraction: () => ({}),
      });
      router.service(ManagementService, {
        setEngineerRuntime: () => ({}),
        saveSkill: () => ({}),
        deleteSkill: () => ({}),
        saveConnection: () => ({}),
        deleteConnection: () => ({}),
        saveSpeechConfiguration: () => ({}),
        saveHarness: () => ({}),
        deleteHarness: () => ({}),
        addKnowledge: () => ({}),
        deleteKnowledge: () => ({}),
        clearKnowledge: () => ({}),
      });
    },
    {
      router: { interceptors: [workspaceContext("workspace", "assistant", async () => principal)] },
    },
  );
  const agents = createClient(ConsoleService, transport),
    resources = createClient(ManagementService, transport);
  const mutations: [Capability, () => Promise<unknown>][] = [
    [Capability.AGENTS_MANAGE, () => agents.createRole({})],
    [Capability.AGENTS_MANAGE, () => agents.updateRole({})],
    [Capability.AGENTS_MANAGE, () => resources.setEngineerRuntime({})],
    [Capability.SKILLS_MANAGE, () => resources.saveSkill({})],
    [Capability.SKILLS_MANAGE, () => resources.deleteSkill({})],
    [
      Capability.MCP_MANAGE,
      () => resources.saveConnection({ connection: { kind: ConnectionKind.MCP } }),
    ],
    [Capability.MCP_MANAGE, () => resources.deleteConnection({ kind: ConnectionKind.MCP })],
    [
      Capability.MODELS_MANAGE,
      () => resources.saveConnection({ connection: { kind: ConnectionKind.MODEL } }),
    ],
    [Capability.MODELS_MANAGE, () => resources.deleteConnection({ kind: ConnectionKind.MODEL })],
    [Capability.MODELS_MANAGE, () => resources.saveSpeechConfiguration({})],
    [Capability.HARNESSES_MANAGE, () => resources.saveHarness({})],
    [Capability.HARNESSES_MANAGE, () => resources.deleteHarness({})],
    [Capability.KNOWLEDGE_MANAGE, () => resources.addKnowledge({})],
    [Capability.KNOWLEDGE_MANAGE, () => resources.deleteKnowledge({})],
    [Capability.KNOWLEDGE_MANAGE, () => resources.clearKnowledge({})],
  ];
  for (const granted of [
    [],
    ...allCapabilities.map((capability) => [capability]),
    allCapabilities,
  ]) {
    principal.capabilities = granted;
    principal.write = !granted.length;
    for (const [required, mutate] of mutations) {
      if (granted.includes(required)) await mutate();
      else await expect(mutate()).rejects.toMatchObject({ code: Code.PermissionDenied });
    }
    await agents.sendMessage({});
    await agents.cancelTask({});
    await agents.updateTaskTags({});
    await agents.respondInteraction({});
    await expect(resources.saveConnection({})).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    await expect(resources.deleteConnection({})).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  }
});

it("maps only canonical signed application roles and supports combinations", () => {
  expect(roleCapabilities(["writer", "agentos-admin", "admins", "aiops/skills"])).toEqual([]);
  for (const capability of allCapabilities)
    expect(roleCapabilities([capabilityRole(capability)])).toEqual([capability]);
  expect(roleCapabilities(allCapabilities.map(capabilityRole))).toEqual(allCapabilities);
});
