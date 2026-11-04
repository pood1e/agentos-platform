import type { AgentTemplate } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import type { Agent } from "../../gen/kagent/api/v1/agents_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { object, text } from "../../shared/json.js";
import { displayNameAnnotation } from "../../shared/kagent-resources.js";
import { agentKey } from "../kagent/resources.js";
import { millis } from "./decode/messages.js";

export interface AgentInfo {
  id: string;
  templateName: string;
  displayName: string;
  description: string;
  ready: boolean;
  reason: string;
  message: string;
}

export function agentInfo(agent: Agent, templates?: ReadonlyMap<string, AgentTemplate>): AgentInfo {
  const resource = agent.resource?.value;
  const metadata = object(resource?.metadata);
  const templateRef = object(object(object(resource?.spec).template).ref);
  const template = templates?.get(`${agent.ref?.namespace}/${text(templateRef.name)}`)?.resource
    ?.value;
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
    templateName: text(templateRef.name),
    displayName: text(annotations[displayNameAnnotation]),
    description: template
      ? text(object(template.spec).description)
      : text(annotations["agentos.dev/description"]),
    ready,
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

export const sessionInfo = (session: Session) => ({
  root: session.authority?.rootSessionId || session.id,
  subject: session.authority?.initiatorId || session.creator,
  id: session.id,
  agentId: agentKey(session.agent?.ref),
  name: session.name,
  updatedAt: millis(session.updatedAt),
});
