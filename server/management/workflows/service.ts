import { isDeepStrictEqual } from "node:util";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ToolBindingSchema } from "../../../gen/agentos/console/v1/role_pb.js";
import {
  type PublishWorkflowRequest,
  type SaveWorkflowLayoutRequest,
  type Workflow,
  WorkflowSchema,
} from "../../../gen/agentos/management/v1/workflow_pb.js";
import { object, text } from "../../../shared/json.js";
import type { BindingView } from "../../governance/bindings.js";
import type { KagentClients } from "../../kagent/clients.js";
import { conflict, invalid } from "../../shared/errors.js";
import { credentialReferences, userResource } from "../native.js";
import type { ResourceStore } from "../resources.js";
import { workflowCatalog } from "./catalog.js";
import {
  agentSpec,
  apiVersion,
  checkDocument,
  definitionResource,
  definitionSpec,
  templateReference,
  withLayout,
} from "./definition.js";
import type { WorkflowDocuments } from "./documents.js";

export function workflowCommands(
  store: ResourceStore,
  clients: KagentClients,
  documents: WorkflowDocuments,
  namespace: string,
  access: BindingView,
) {
  const catalog = workflowCatalog(clients, documents, namespace);
  function owner(workflow: Workflow) {
    return templateReference(workflow.agent) || catalog.reference(workflow.agent?.ref).name;
  }
  async function candidate(workflow: Workflow) {
    const ref = catalog.reference(workflow.agent?.ref);
    const spec = definitionSpec(workflow);
    if (
      workflow.agentTemplate &&
      (workflow.agentTemplate.ref?.namespace !== namespace ||
        workflow.agentTemplate.ref.name !== templateReference(workflow.agent))
    )
      throw invalid("workflow.invalidReference");
    checkDocument(workflow.document);
    if (spec.systemPrompt !== undefined || spec.systemPromptFrom !== undefined)
      throw invalid("workflow.invalidTemplate");
    const raw = Array.isArray(spec.tools) ? spec.tools.map(object) : [];
    if (
      raw.some(
        (binding) =>
          !binding.mcp ||
          !Array.isArray(object(binding.mcp).tools) ||
          !(object(binding.mcp).tools as unknown[]).length,
      )
    )
      throw invalid("configuration.invalidTools");
    const bindings = (await access()).bindings(
      owner(workflow),
      raw.map((binding) => {
        const mcp = object(binding.mcp);
        return create(ToolBindingSchema, {
          server: text(object(mcp.server).name),
          tools: mcp.tools as string[],
          requireApproval: mcp.requireApproval === true,
        });
      }),
      "validate",
    );
    if (!bindings) throw invalid("configuration.invalidTools");
    return {
      ref,
      spec: {
        ...spec,
        tools: bindings.map((binding) => ({
          mcp: {
            server: { kind: "RemoteMCPServer", name: binding.server },
            tools: binding.tools,
            requireApproval: binding.requireApproval,
          },
        })),
        workflowFrom: documents.source(owner(workflow), workflow.document),
      },
    };
  }
  async function validate(workflow: Workflow | undefined) {
    if (!workflow?.agent) throw invalid("workflow.invalidReference");
    const prepared = await candidate(workflow);
    return compile(workflow, prepared);
  }
  async function compile(workflow: Workflow, { ref, spec }: Awaited<ReturnType<typeof candidate>>) {
    const result = await clients.workflows.validateWorkflow(
      {
        ref,
        document: new TextEncoder().encode(workflow.document),
        resource: {
          apiVersion,
          kind: "Agent",
          value: {
            ...workflow.agent?.resource?.value,
            apiVersion,
            kind: "Agent",
            metadata: {
              ...object(workflow.agent?.resource?.value?.metadata),
              namespace: ref.namespace,
              name: ref.name,
            },
            spec: {
              ...agentSpec(workflow.agent),
              template: workflow.agentTemplate
                ? { ref: { name: workflow.agentTemplate.ref?.name ?? "" } }
                : { inline: spec },
            },
          },
        },
        agentTemplate: workflow.agentTemplate
          ? {
              apiVersion,
              kind: "AgentTemplate",
              value: {
                ...workflow.agentTemplate.resource?.value,
                metadata: {
                  ...object(workflow.agentTemplate.resource?.value?.metadata),
                  namespace,
                  name: workflow.agentTemplate.ref?.name ?? "",
                },
                spec,
              },
            }
          : undefined,
      },
      { timeoutMs: 30_000 },
    );
    return { preparedRevision: result.preparedRevision };
  }
  async function publish(request: PublishWorkflowRequest) {
    const draft = request.workflow;
    if (!draft?.agent) throw invalid("workflow.invalidReference");
    const { ref, spec } = await candidate(draft);
    const current = await catalog.optional(ref);
    if (!request.create && !current) throw invalid("workflow.notFound");
    const target = current ? definitionResource(current) : undefined;
    const desired = userResource(
      withLayout(
        {
          ...definitionResource(draft),
          apiVersion,
          kind: draft.agentTemplate ? "AgentTemplate" : "Agent",
          metadata: {
            ...object(definitionResource(draft).metadata),
            namespace,
            name: owner(draft),
          },
          spec: draft.agentTemplate
            ? spec
            : { ...agentSpec(draft.agent), template: { inline: spec } },
        },
        draft,
      ),
    );
    if (current) {
      if (
        templateReference(current.agent) !== templateReference(draft.agent) ||
        (draft.agentTemplate &&
          !isDeepStrictEqual(agentSpec(current.agent), agentSpec(draft.agent)))
      )
        throw invalid("workflow.runtimeChanged");
      if (
        current.document === draft.document &&
        isDeepStrictEqual(target?.spec, desired.spec) &&
        isDeepStrictEqual(
          object(object(target?.metadata).annotations),
          object(object(desired.metadata).annotations),
        )
      )
        return { workflow: current };
      if (request.create) throw new ConnectError("Workflow already exists", Code.AlreadyExists);
      const expected = object(desired.metadata);
      const actual = object(target?.metadata);
      if (expected.resourceVersion !== actual.resourceVersion || expected.uid !== actual.uid)
        throw conflict("configuration.conflict");
    }
    credentialReferences(spec, current ? definitionSpec(current) : undefined);
    await compile(draft, { ref, spec });
    await documents.stage(owner(draft), draft.document);
    await documents.prune(owner(draft), draft.document);
    if (request.create) {
      if (draft.agentTemplate) {
        try {
          await store.save("templates", desired, true);
        } catch (error) {
          // An earlier accepted template may have lost its response before Agent creation.
          if (!(error instanceof ConnectError && error.code === Code.AlreadyExists)) throw error;
          const existing = await store.get("templates", owner(draft));
          if (!isDeepStrictEqual(existing.spec, desired.spec)) throw error;
        }
        await store.save(
          "agents",
          {
            ...draft.agent.resource?.value,
            apiVersion,
            kind: "Agent",
            metadata: {
              ...object(draft.agent.resource?.value?.metadata),
              namespace,
              name: ref.name,
            },
          },
          true,
        );
      } else await store.save("agents", desired, true);
    } else
      await store.save(draft.agentTemplate ? "templates" : "agents", userResource(desired), false);
    return { workflow: await catalog.read(ref) };
  }
  async function layout(request: SaveWorkflowLayoutRequest) {
    const current = await catalog.read(request.ref);
    const value = definitionResource(current);
    if (text(object(value.metadata).resourceVersion) !== request.resourceVersion)
      throw conflict("configuration.conflict");
    const draft = create(WorkflowSchema, { ...current, layout: request.layout });
    await store.save(
      current.agentTemplate ? "templates" : "agents",
      withLayout(value, draft),
      false,
    );
    return { workflow: await catalog.read(request.ref) };
  }
  return { list: catalog.list, read: catalog.read, validate, publish, layout };
}
