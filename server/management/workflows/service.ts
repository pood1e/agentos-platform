import { isDeepStrictEqual } from "node:util";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ToolBindingSchema } from "../../../gen/agentos/console/v1/role_pb.js";
import {
  type PublishWorkflowRequest,
  type SaveWorkflowLayoutRequest,
  type Workflow,
  WorkflowSchema,
} from "../../../gen/agentos/management/v1/workflow_pb.js";
import { object, text } from "../../../shared/json.js";
import { kagentApiVersion as apiVersion } from "../../../shared/kagent-resources.js";
import type { BindingView } from "../../governance/tool-bindings.js";
import type { KagentClients } from "../../kagent/clients.js";
import { userResource } from "../../kagent/resources.js";
import { bindingFromSpec, bindingSpec } from "../../kagent/role-template.js";
import { conflict, hasCode, invalid } from "../../shared/errors.js";
import { credentialReferences } from "../native.js";
import type { ResourceStore } from "../resources.js";
import { workflowCatalog } from "./catalog.js";
import {
  agentSpec,
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
    const requested = (Array.isArray(spec.tools) ? spec.tools.map(object) : []).map(
      bindingFromSpec,
    );
    if (requested.some((binding) => !binding.tools.length))
      throw invalid("configuration.invalidTools");
    const bindings = (await access()).bindings(
      owner(workflow),
      requested.map((binding) => create(ToolBindingSchema, binding)),
      "validate",
    );
    if (!bindings) throw invalid("configuration.invalidTools");
    return {
      ref,
      spec: {
        ...spec,
        tools: bindings.map(bindingSpec),
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
  function desiredResource(draft: Workflow, spec: JsonObject) {
    return userResource(
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
  }
  /** Agent and template are separate native objects, so a retry may find the template committed. */
  async function createDefinition(
    draft: Workflow,
    desired: JsonObject,
    ref: Awaited<ReturnType<typeof candidate>>["ref"],
  ) {
    if (!draft.agentTemplate) {
      await store.save("agents", desired, true);
      return;
    }
    try {
      await store.save("templates", desired, true);
    } catch (error) {
      if (!hasCode(error, Code.AlreadyExists)) throw error;
      const existing = await store.get("templates", owner(draft));
      if (!isDeepStrictEqual(existing.spec, desired.spec)) throw error;
    }
    await store.save(
      "agents",
      {
        ...draft.agent?.resource?.value,
        apiVersion,
        kind: "Agent",
        metadata: {
          ...object(draft.agent?.resource?.value?.metadata),
          namespace,
          name: ref.name,
        },
      },
      true,
    );
  }
  async function publish(request: PublishWorkflowRequest) {
    const draft = request.workflow;
    if (!draft?.agent) throw invalid("workflow.invalidReference");
    const { ref, spec } = await candidate(draft);
    const current = await catalog.optional(ref);
    if (!request.create && !current) throw invalid("workflow.notFound");
    const desired = desiredResource(draft, spec);
    if (current) {
      const target = definitionResource(current);
      if (
        templateReference(current.agent) !== templateReference(draft.agent) ||
        (draft.agentTemplate &&
          !isDeepStrictEqual(agentSpec(current.agent), agentSpec(draft.agent)))
      )
        throw invalid("workflow.runtimeChanged");
      if (
        current.document === draft.document &&
        isDeepStrictEqual(target.spec, desired.spec) &&
        isDeepStrictEqual(
          object(object(target.metadata).annotations),
          object(object(desired.metadata).annotations),
        )
      )
        return { workflow: current };
      if (request.create) throw new ConnectError("Workflow already exists", Code.AlreadyExists);
      const expected = object(desired.metadata);
      const actual = object(target.metadata);
      if (expected.resourceVersion !== actual.resourceVersion || expected.uid !== actual.uid)
        throw conflict("configuration.conflict");
    }
    credentialReferences(spec, current ? definitionSpec(current) : undefined);
    await compile(draft, { ref, spec });
    await documents.stage(owner(draft), draft.document);
    await documents.prune(owner(draft), draft.document);
    if (request.create) await createDefinition(draft, desired, ref);
    else await store.save(draft.agentTemplate ? "templates" : "agents", desired, false);
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
