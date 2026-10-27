import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import { can, isAdministrator } from "../../shared/permissions.js";
import type { Viewer } from "../read-model/listings.js";
import type { TaskProjection } from "../read-model/projection.js";
import { notFound } from "../shared/errors.js";

/** Whose executions a request reads; administrators also read shared service work. */
export function viewer(identity: ExecutionIdentity, systemOnly = false): Viewer {
  return { subject: identity.subject, administrator: isAdministrator(identity), systemOnly };
}

const readable = (subject: string, reader: Viewer) =>
  reader.systemOnly
    ? subject.startsWith("service:")
    : subject === reader.subject || (reader.administrator && subject.startsWith("service:"));

/**
 * The execution tree of a task or conversation the identity may read.
 * Read access survives cancellation and credential expiry; it never grants execution authority.
 */
export async function visibleGraph(
  projection: Pick<TaskProjection, "entry" | "session" | "graph">,
  reader: Viewer,
  id: { taskId?: string; contextId?: string },
) {
  const owner = id.taskId
    ? await projection.entry(id.taskId)
    : await projection.session(id.contextId ?? "");
  if (!owner?.root || !owner.subject || !readable(owner.subject, reader)) return undefined;
  return projection.graph([owner.root]);
}

type AgentRef = Pick<ResourceReference, "namespace" | "name"> | undefined;

const chatAgent = (namespace: string, entry: string, ref: AgentRef, identity: ExecutionIdentity) =>
  ref?.namespace === namespace &&
  (ref.name === entry || (ref.name === "role-builder" && can(identity, Capability.AGENTS_MANAGE)));

export function chatTarget(
  namespace: string,
  entry: string,
  ref: AgentRef,
  identity: ExecutionIdentity,
) {
  if (!chatAgent(namespace, entry, ref, identity)) throw notFound("chat.invalidConversation");
}

/** Other workspace agents expose only shared service sessions, read by administrators. */
export function systemConversation(
  namespace: string,
  entry: string,
  ref: AgentRef,
  identity: ExecutionIdentity,
  contextId: string,
) {
  if (chatAgent(namespace, entry, ref, identity)) return false;
  if (ref?.namespace === namespace && contextId && isAdministrator(identity)) return true;
  throw notFound("chat.invalidConversation");
}
