import { clone, create } from "@bufbuild/protobuf";
import { type Workflow, WorkflowSchema } from "../../../gen/agentos/management/v1/workflow_pb.js";
import { object } from "../../../shared/json.js";
import { initialDocument } from "./document.js";

const apiVersion = "api.kagent.dev/v1alpha3";
export function newWorkflow(namespace: string, name = ""): Workflow {
  return create(WorkflowSchema, {
    agent: {
      ref: { namespace, name },
      resource: {
        apiVersion,
        kind: "Agent",
        value: {
          apiVersion,
          kind: "Agent",
          metadata: { name, namespace },
          spec: { harnessRef: { name: "standard" }, template: { ref: { name } } },
        },
      },
    },
    agentTemplate: {
      ref: { namespace, name },
      resource: {
        apiVersion,
        kind: "AgentTemplate",
        value: {
          apiVersion,
          kind: "AgentTemplate",
          metadata: { name, namespace },
          spec: { workflowFrom: { name: "candidate", key: "workflow.yaml" } },
        },
      },
    },
    document: initialDocument,
  });
}
export const workflowSpec = (workflow: Workflow) =>
  workflow.agentTemplate
    ? object(workflow.agentTemplate.resource?.value?.spec)
    : object(object(object(workflow.agent?.resource?.value?.spec).template).inline);
export const workflowOwner = (workflow: Workflow) =>
  workflow.agentTemplate?.resource?.value ?? workflow.agent?.resource?.value ?? {};
export function updateSpec(workflow: Workflow, spec: ReturnType<typeof workflowSpec>): Workflow {
  const next = clone(WorkflowSchema, workflow);
  if (next.agentTemplate?.resource)
    next.agentTemplate.resource.value = { ...workflowOwner(next), spec };
  else if (next.agent?.resource) {
    const value = next.agent.resource.value ?? {};
    next.agent.resource.value = {
      ...value,
      spec: { ...object(value.spec), template: { inline: spec } },
    };
  }
  return next;
}
