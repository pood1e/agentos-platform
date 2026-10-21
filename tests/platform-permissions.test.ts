import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import {
  CandidateSchema,
  ConfigurationSnapshotSchema,
  EvaluationService,
  ResourceProposalSchema,
} from "../gen/agentos/evaluation/v1/evaluation_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { ConnectionKind, ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { authorizedEvaluation } from "../server/evaluation/access.js";
import type { EvaluationStore } from "../server/evaluation/store.js";
import { requestIdentity, workspaceContext } from "../server/platform/access.js";
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
        respondInteraction: () => ({}),
      });
      router.service(ManagementService, {
        setEngineerRuntime: () => ({}),
        saveSkill: () => ({}),
        deleteSkill: () => ({}),
        saveConnection: () => ({}),
        deleteConnection: () => ({}),
        saveHarness: () => ({}),
        deleteHarness: () => ({}),
        addKnowledge: () => ({}),
        deleteKnowledge: () => ({}),
        clearKnowledge: () => ({}),
      });
      router.service(EvaluationService, {
        runEvaluation: () => ({}),
        publishCandidate: () => ({}),
      });
    },
    {
      router: { interceptors: [workspaceContext("workspace", "assistant", async () => principal)] },
    },
  );
  const agents = createClient(ConsoleService, transport),
    resources = createClient(ManagementService, transport),
    evaluations = createClient(EvaluationService, transport);
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
    [Capability.HARNESSES_MANAGE, () => resources.saveHarness({})],
    [Capability.HARNESSES_MANAGE, () => resources.deleteHarness({})],
    [Capability.KNOWLEDGE_MANAGE, () => resources.addKnowledge({})],
    [Capability.KNOWLEDGE_MANAGE, () => resources.deleteKnowledge({})],
    [Capability.KNOWLEDGE_MANAGE, () => resources.clearKnowledge({})],
    [Capability.EVALUATIONS_MANAGE, () => evaluations.runEvaluation({})],
    [Capability.EVALUATIONS_MANAGE, () => evaluations.publishCandidate({})],
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

it("requires evaluation and all affected resource permissions before committing publication", async () => {
  const publishCandidate = vi.fn(async () => ({}));
  const snapshot = create(ConfigurationSnapshotSchema);
  const store: Pick<EvaluationStore, "get"> = {
    get: async () => ({ snapshot, candidate: create(CandidateSchema), metadata: {} }),
  };
  const service = authorizedEvaluation(
    {
      listCandidates: () => ({}),
      getCandidate: () => ({}),
      runEvaluation: () => ({}),
      publishCandidate,
    },
    store,
  );
  const principal = create(ExecutionIdentitySchema, { subject: "user:reviewer" });
  const client = createClient(
    EvaluationService,
    createRouterTransport((router) => router.service(EvaluationService, service), {
      router: {
        interceptors: [
          (next) => (request) => {
            request.contextValues.set(requestIdentity, principal);
            return next(request);
          },
        ],
      },
    }),
  );
  const proposal = (kind: string, owner?: string) =>
    create(ResourceProposalSchema, {
      resource: {
        kind,
        value: { kind, metadata: { ownerReferences: owner ? [{ kind: owner }] : [] } },
      },
    });
  snapshot.proposals = [
    proposal("Agent"),
    proposal("AgentTemplate"),
    proposal("ConfigMap"),
    proposal("AgentgatewayBackend"),
    proposal("Secret", "AgentgatewayBackend"),
    proposal("HTTPRoute", "AgentgatewayBackend"),
  ];
  for (const granted of [
    [Capability.EVALUATIONS_MANAGE],
    [Capability.AGENTS_MANAGE, Capability.SKILLS_MANAGE, Capability.MCP_MANAGE],
    [Capability.EVALUATIONS_MANAGE, Capability.AGENTS_MANAGE, Capability.SKILLS_MANAGE],
  ]) {
    principal.capabilities = granted;
    await expect(client.publishCandidate({ id: "candidate" })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  }
  expect(publishCandidate).not.toHaveBeenCalled();
  principal.capabilities = [
    Capability.EVALUATIONS_MANAGE,
    Capability.AGENTS_MANAGE,
    Capability.SKILLS_MANAGE,
    Capability.MCP_MANAGE,
  ];
  await client.publishCandidate({ id: "candidate" });
  expect(publishCandidate).toHaveBeenCalledTimes(1);
  principal.capabilities = allCapabilities;
  for (const invalid of [
    proposal("Unknown"),
    proposal("Secret"),
    proposal("HTTPRoute", "Agent"),
    create(ResourceProposalSchema, { resource: { kind: "Agent", value: { kind: "Harness" } } }),
  ]) {
    snapshot.proposals = [invalid];
    await expect(client.publishCandidate({ id: "candidate" })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  }
  expect(publishCandidate).toHaveBeenCalledTimes(1);
});
