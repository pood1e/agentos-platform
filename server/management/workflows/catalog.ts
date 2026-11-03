import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { type Workflow, WorkflowSchema } from "../../../gen/agentos/management/v1/workflow_pb.js";
import type { ResourceReference } from "../../../gen/kagent/api/v1/common_pb.js";
import { object, text } from "../../../shared/json.js";
import { listNativeAgents, listNativeTemplates } from "../../kagent/catalog.js";
import type { KagentClients } from "../../kagent/clients.js";
import { isWorkflowTemplate } from "../../kagent/resources.js";
import { hasCode, invalid, notFound, unlessMissing } from "../../shared/errors.js";
import { agentSpec, definitionSpec, templateReference, workflowView } from "./definition.js";
import type { WorkflowDocuments } from "./documents.js";

export function workflowCatalog(
  clients: KagentClients,
  documents: WorkflowDocuments,
  namespace: string,
) {
  function reference(ref: ResourceReference | undefined) {
    if (!ref?.name || ref.namespace !== namespace) throw invalid("workflow.invalidReference");
    return ref;
  }
  async function read(ref: ResourceReference | undefined) {
    const { agent } = await clients.agents.getAgent({ ref: reference(ref) });
    if (!agent) throw notFound("management.notFound");
    const templateName = templateReference(agent);
    const template = templateName
      ? (await clients.templates.getAgentTemplate({ ref: { namespace, name: templateName } }))
          .agentTemplate
      : undefined;
    const spec = definitionSpec(create(WorkflowSchema, { agent, agentTemplate: template }));
    if (!isWorkflowTemplate(spec)) throw notFound("workflow.notFound");
    const source = object(spec.workflowFrom);
    const document = await documents.read(text(source.name), text(source.key));
    let preparedRevision = "";
    try {
      preparedRevision = (await clients.workflows.getWorkflowRevision({ ref })).preparedRevision;
    } catch (error) {
      // An invalid persisted definition remains editable; native status carries its diagnostics.
      if (!hasCode(error, Code.InvalidArgument)) throw error;
    }
    return workflowView(agent, template, document, preparedRevision);
  }
  const optional = (ref: ResourceReference | undefined): Promise<Workflow | undefined> =>
    unlessMissing(read(ref));
  async function list() {
    const [agents, templates] = await Promise.all([
      listNativeAgents(clients, namespace),
      listNativeTemplates(clients, namespace),
    ]);
    const byName = new Map(templates.map((template) => [template.ref?.name, template]));
    return {
      agents: agents.filter((agent) =>
        isWorkflowTemplate(
          templateReference(agent)
            ? byName.get(templateReference(agent))?.resource?.value?.spec
            : object(object(agentSpec(agent).template).inline),
        ),
      ),
    };
  }
  return { reference, read, optional, list };
}
