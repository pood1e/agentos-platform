import { create, fromJsonString, type JsonObject, toJsonString } from "@bufbuild/protobuf";
import { parseDocument } from "yaml";
import {
  type Workflow,
  WorkflowLayoutSchema,
  WorkflowSchema,
} from "../../../gen/agentos/management/v1/workflow_pb.js";
import type { AgentTemplate } from "../../../gen/kagent/api/v1/agent_templates_pb.js";
import type { Agent } from "../../../gen/kagent/api/v1/agents_pb.js";
import { object, text } from "../../../shared/json.js";
import { invalid } from "../../shared/errors.js";
import { documentDigest } from "./documents.js";

const layoutKey = "agentos.dev/workflow-layout";
export const agentSpec = (agent?: Agent) => object(agent?.resource?.value?.spec);
export const templateReference = (agent?: Agent) =>
  text(object(object(agentSpec(agent).template).ref).name);
export const definitionSpec = (workflow: Workflow) =>
  workflow.agentTemplate
    ? object(workflow.agentTemplate.resource?.value?.spec)
    : object(object(agentSpec(workflow.agent).template).inline);
export const definitionResource = (workflow: Workflow) =>
  workflow.agentTemplate?.resource?.value ?? workflow.agent?.resource?.value ?? {};

export function checkDocument(document: string) {
  if (!document || Buffer.byteLength(document) > 65_536) throw invalid("workflow.invalidDocument");
  try {
    const parsed = parseDocument(document, { uniqueKeys: true });
    if (parsed.errors.length) throw parsed.errors[0];
    const value = object(parsed.toJS({ maxAliasCount: 0 }));
    if (value.apiVersion !== "adk.declarative/v0.2" || value.kind !== "AgentSystem")
      throw new Error("Invalid native document");
  } catch {
    throw invalid("workflow.invalidDocument");
  }
}

export function workflowView(
  agent: Agent,
  template: AgentTemplate | undefined,
  document: string,
  preparedRevision: string,
): Workflow {
  checkDocument(document);
  const resource = template?.resource?.value ?? agent.resource?.value;
  const annotation = object(object(resource?.metadata).annotations)[layoutKey];
  return create(WorkflowSchema, {
    agent,
    agentTemplate: template,
    document,
    sourceSha256: documentDigest(document),
    preparedRevision,
    layout:
      typeof annotation === "string" ? fromJsonString(WorkflowLayoutSchema, annotation) : undefined,
  });
}

export function withLayout(resource: JsonObject, workflow: Workflow): JsonObject {
  const metadata = object(resource.metadata);
  return {
    ...resource,
    metadata: {
      ...metadata,
      annotations: {
        ...object(metadata.annotations),
        [layoutKey]: toJsonString(
          WorkflowLayoutSchema,
          workflow.layout ?? create(WorkflowLayoutSchema),
        ),
      },
    },
  };
}
