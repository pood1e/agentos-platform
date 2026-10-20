import type { AgentTemplate } from "../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import type { Agent } from "../../gen/kagent/api/v1alpha1/agents_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1alpha1/common_pb.js";
import type { Session } from "../../gen/kagent/api/v1alpha1/sessions_pb.js";
import { millis, object, text } from "./decode/messages.js";

export const systemRoles = new Set(["assistant", "role-builder"]);

export const agentKey = (ref?: Pick<ResourceReference, "namespace" | "name">) =>
  ref ? `${ref.namespace}/${ref.name}` : "";

export interface AgentInfo {
  id: string;
  role: string;
  displayName: string;
  description: string;
  ready: boolean;
  sessionTasks?: boolean;
  reason: string;
  message: string;
}

export function agentInfo(agent: Agent, templates?: ReadonlyMap<string, AgentTemplate>): AgentInfo {
  const resource = agent.resource?.value;
  const metadata = object(resource?.metadata);
  const templateRef = object(object(resource?.spec).templateRef);
  const template = templates?.get(
    `${text(templateRef.namespace) || agent.ref?.namespace}/${text(templateRef.name)}`,
  )?.resource?.value;
  const annotations = object(
    template ? object(template.metadata).annotations : metadata.annotations,
  );
  const raw = object(resource?.status).conditions;
  const conditions = Array.isArray(raw) ? raw.map(object) : [];
  const readiness = conditions.find((condition) => condition.type === "Ready");
  const ready = readiness?.status === "True";
  const blocking = conditions.find((condition) => condition.status === "False") ?? readiness;
  return {
    id: agentKey(agent.ref),
    role:
      text(object(metadata.labels)["agentos.dev/role"]) ||
      text(object(object(resource?.spec).templateRef).name),
    displayName: text(annotations["agentos.dev/display-name"]),
    description: template
      ? text(object(template.spec).description)
      : text(annotations["agentos.dev/description"]),
    ready,
    sessionTasks: object(metadata.annotations)["agentos.dev/task-scope"] === "session",
    reason: ready ? "" : text(blocking?.reason),
    message: ready ? "" : text(blocking?.message),
  };
}

export interface SessionInfo {
  id: string;
  agentId: string;
  name: string;
  updatedAt?: number;
}

export const sessionInfo = (session: Session): SessionInfo => ({
  id: session.id,
  agentId: agentKey(session.agent),
  name: session.name,
  updatedAt: millis(session.updatedAt),
});
