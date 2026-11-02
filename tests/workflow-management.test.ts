import { clone, create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserIdentitySchema } from "../gen/agentos/authorization/v1/identity_pb.js";
import { ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import {
  PublishWorkflowRequestSchema,
  SaveWorkflowLayoutRequestSchema,
  WorkflowSchema,
} from "../gen/agentos/management/v1/workflow_pb.js";
import { GetSessionAuthorityResponseSchema } from "../gen/kagent/api/v1/execution_pb.js";
import { definitionResource, definitionSpec } from "../server/management/workflows/definition.js";
import { workflowCommands } from "../server/management/workflows/service.js";
import { taskQueries } from "../server/read-model/queries.js";
import { object } from "../shared/json.js";
import { initialDocument } from "../src/features/workflows/document.js";
import { newWorkflow, updateSpec } from "../src/features/workflows/draft.js";
import { consoleClient, publishTargets } from "./harness.js";
import { managementEnvironment } from "./management-harness.js";
import { allowWorkspace, testWorkspaceContext } from "./workspace-member.js";

let env: Awaited<ReturnType<typeof managementEnvironment>>;
beforeEach(async () => {
  env = await managementEnvironment();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.close();
});
const commands = () =>
  workflowCommands(
    env.store,
    env.clients,
    env.dependencies.documents,
    "agentos",
    env.dependencies.access,
  );
const publish = (workflow = newWorkflow("agentos", "flow"), createResource = true) =>
  commands().publish(create(PublishWorkflowRequestSchema, { workflow, create: createResource }));
const nextDocument = (source: string) =>
  source.replace("output: input", "output: input.upperAscii()");

it("discovers native workflows independently of Pack and editable roles", async () => {
  await publish();
  const result = await commands().list();
  expect(result.agents.map((agent) => agent.ref?.name)).toEqual(["flow"]);
  expect((await commands().read(result.agents[0].ref)).document).toBe(initialDocument);
  const schema = await env.clients.workflows.getWorkflowSchema({});
  expect(schema.schema).toHaveProperty("$defs.Node.oneOf");
});

it("starts a tool-free workflow and lists its runs without a business role", async () => {
  const { workflow } = await publish();
  if (!workflow) throw new Error("missing workflow");
  const client = consoleClient({
    ...env,
    projection: taskQueries({ workspace: "agentos", clients: env.clients }),
  });
  expect((await client.getConfiguration({})).roles.some((role) => role.name === "flow")).toBe(
    false,
  );
  expect((await client.listAgents({})).agents.some((agent) => agent.id === "agentos/flow")).toBe(
    true,
  );
  const result = await client.sendMessage({
    agent: workflow.agent?.ref,
    text: "input",
    messageId: "pure-workflow",
  });
  const runs = await client.listAgentRuns({ agent: workflow.agent?.ref });
  expect(
    runs.runs.some((run) => run.taskId === result.taskId && run.agentId === "agentos/flow"),
  ).toBe(true);
});

it("validates candidate inputs without creating source resources", async () => {
  const validate = vi.spyOn(env.clients.workflows, "validateWorkflow");
  const sourceCount = env.fake.resources.list("configmaps").length;
  const draft = newWorkflow("agentos", "flow");
  await commands().validate(draft);
  expect(env.fake.resources.list("configmaps")).toHaveLength(sourceCount);
  expect(validate.mock.calls[0][0]).toMatchObject({
    ref: draft.agent?.ref,
    document: new TextEncoder().encode(initialDocument),
  });
  expect(validate.mock.calls[0][0].agentTemplate?.value?.spec).toMatchObject({
    workflowFrom: { key: "workflow.yaml" },
  });
});

it("leaves the published pointer and original document unchanged on native rejection", async () => {
  const { workflow } = await publish();
  if (!workflow) throw new Error("missing workflow");
  const source = definitionSpec(workflow).workflowFrom;
  const count = env.fake.resources.list("configmaps").length;
  vi.spyOn(env.clients.workflows, "validateWorkflow").mockRejectedValueOnce(
    new ConnectError("invalid graph: unconditional cycle", Code.InvalidArgument),
  );
  const draft = clone(WorkflowSchema, workflow);
  draft.document = nextDocument(draft.document);
  await expect(publish(draft, false)).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect(definitionSpec(await commands().read(workflow.agent?.ref)).workflowFrom).toEqual(source);
  expect(env.fake.resources.list("configmaps")).toHaveLength(count);
});

it("publishes an immutable source with optimistic concurrency and retains preset prompt keys", async () => {
  const { workflow } = await publish();
  if (!workflow) throw new Error("missing workflow");
  const source = object(definitionSpec(workflow).workflowFrom);
  expect(env.fake.resources.get("configmaps", String(source.name))).toMatchObject({
    immutable: true,
  });
  const first = clone(WorkflowSchema, workflow);
  const second = clone(WorkflowSchema, workflow);
  first.document = nextDocument(first.document);
  await publish(first, false);
  second.document = second.document.replace("output: input", "output: 'stale'");
  await expect(publish(second, false)).rejects.toMatchObject({ code: Code.Aborted });
  const latest = await commands().read(workflow.agent?.ref);
  expect(latest.document).toBe(first.document);
  expect(
    object(env.fake.resources.get("configmaps", String(source.name)).data)["workflow.yaml"],
  ).toBe(initialDocument);
});

it("recovers publication when a committed acknowledgement is lost", async () => {
  const { workflow } = await publish();
  if (!workflow) throw new Error("missing workflow");
  const draft = clone(WorkflowSchema, workflow);
  draft.document = nextDocument(draft.document);
  const write = env.store.save;
  const save = vi.spyOn(env.store, "save").mockImplementationOnce(async (...args) => {
    await write(...args);
    throw new ConnectError("response lost", Code.Unavailable);
  });
  await expect(publish(draft, false)).rejects.toMatchObject({ code: Code.Unavailable });
  save.mockRestore();
  expect((await publish(draft, false)).workflow?.document).toBe(draft.document);
});

it("saves layout without changing execution inputs or creating a source revision", async () => {
  const { workflow } = await publish();
  if (!workflow) throw new Error("missing workflow");
  const previous = definitionSpec(workflow);
  const count = env.fake.resources.list("configmaps").length;
  const { workflow: saved } = await commands().layout(
    create(SaveWorkflowLayoutRequestSchema, {
      ref: workflow.agent?.ref,
      resourceVersion: String(object(definitionResource(workflow).metadata).resourceVersion),
      layout: { nodes: [{ path: "workflow/result", x: 10, y: -25 }] },
    }),
  );
  expect(saved.layout?.nodes).toMatchObject([{ path: "workflow/result", x: 10, y: -25 }]);
  expect(definitionSpec(saved)).toEqual(previous);
  expect(env.fake.resources.list("configmaps")).toHaveLength(count);
});

it("uses the Agent owner for inline workflows", async () => {
  const draft = newWorkflow("agentos", "inline-flow");
  const spec = definitionSpec(draft);
  draft.agentTemplate = undefined;
  if (!draft.agent?.resource) throw new Error("missing Agent");
  draft.agent.resource.value = {
    ...draft.agent.resource.value,
    spec: { harnessRef: { name: "standard" }, template: { inline: spec } },
  };
  const { workflow } = await publish(draft);
  expect(workflow?.agentTemplate).toBeUndefined();
  expect(workflow?.document).toBe(initialDocument);
});

it("keeps governance approval decisions authoritative for workflow tool bindings", async () => {
  publishTargets(env.fake, [
    {
      server: "fabric-remediation",
      service: "remediation",
      catalog: false,
      tools: [{ name: "change", write: true, requireApproval: true }],
    },
  ]);
  const native = vi
    .spyOn(env.clients.workflows, "validateWorkflow")
    .mockImplementationOnce(async (request) => {
      expect(object(request.agentTemplate?.value?.spec).tools).toEqual([
        {
          mcp: {
            server: { kind: "RemoteMCPServer", name: "fabric-remediation" },
            tools: ["change"],
            requireApproval: true,
          },
        },
      ]);
      throw new ConnectError("workflow root cannot pause for approval", Code.InvalidArgument);
    });
  const draft = updateSpec(newWorkflow("agentos", "remediation"), {
    tools: [
      {
        mcp: {
          server: { kind: "RemoteMCPServer", name: "fabric-remediation" },
          tools: ["change"],
          requireApproval: false,
        },
      },
    ],
  });
  await expect(commands().validate(draft)).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect(native).toHaveBeenCalledOnce();
});

it("enforces workspace and administration gates before workflow source writes", async () => {
  await expect(commands().validate(newWorkflow("foreign", "flow"))).rejects.toMatchObject({
    code: Code.InvalidArgument,
  });
  const client = createClient(
    ManagementService,
    createRouterTransport((router) => router.service(ManagementService, env.service), {
      router: {
        interceptors: [
          testWorkspaceContext(
            "agentos",
            async () => create(UserIdentitySchema, { subject: "reader" }),
            allowWorkspace("agentos"),
          ),
          createValidateInterceptor(),
        ],
      },
    }),
  );
  const before = env.fake.resources.list("configmaps").length;
  await expect(
    client.publishWorkflow({ workflow: newWorkflow("agentos", "flow"), create: true }),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  expect(env.fake.resources.list("configmaps")).toHaveLength(before);
});

it("reads a Session's pinned workflow after later publications", async () => {
  const { workflow } = await publish();
  if (!workflow) throw new Error("missing workflow");
  const { session } = await env.clients.sessions.createSession({
    agent: workflow.agent?.ref,
    requestId: "native-workflow-run",
  });
  const draft = clone(WorkflowSchema, workflow);
  draft.document = nextDocument(draft.document);
  await publish(draft, false);
  const pinned = await env.clients.workflows.getSessionWorkflow({ sessionId: session?.id });
  expect(new TextDecoder().decode(pinned.document)).toBe(initialDocument);
});

it("rejects a pinned workflow from a recreated workspace", async () => {
  const { workflow } = await publish();
  const { session } = await env.clients.sessions.createSession({
    agent: workflow?.agent?.ref,
    requestId: "workspace-recreation",
  });
  vi.spyOn(env.clients.execution, "getSessionAuthority").mockResolvedValueOnce(
    create(GetSessionAuthorityResponseSchema, {
      authority: { sessionId: session?.id, workspaceUid: "previous-uid" },
    }),
  );
  const client = createClient(
    ManagementService,
    createRouterTransport((router) => router.service(ManagementService, env.service), {
      router: {
        interceptors: [
          testWorkspaceContext(
            "agentos",
            async () => create(UserIdentitySchema, { subject: "reader" }),
            allowWorkspace("agentos"),
          ),
        ],
      },
    }),
  );
  await expect(client.getSessionWorkflow({ sessionId: session?.id })).rejects.toMatchObject({
    code: Code.NotFound,
  });
});
