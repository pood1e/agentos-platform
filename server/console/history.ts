import { Code, ConnectError } from "@connectrpc/connect";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import { can, isAdministrator } from "../../shared/permissions.js";
import type { Viewer } from "../read-model/listings.js";
import type { TaskQueries } from "../read-model/queries.js";
import { notFound } from "../shared/errors.js";

/** The requested execution view; native reads retain their own authorization. */
export function viewer(identity: UserIdentity, systemOnly = false): Viewer {
  const administrator = isAdministrator(identity);
  if (systemOnly && !administrator)
    throw new ConnectError("Permission denied", Code.PermissionDenied);
  return { subject: identity.subject, administrator, systemOnly };
}

/**
 * The execution tree of a task or conversation the identity may read.
 * Read access survives cancellation and credential expiry; it never grants execution authority.
 */
export async function visibleGraph(
  projection: Pick<TaskQueries, "entry" | "session" | "graph">,
  reader: Viewer,
  id: { taskId?: string; contextId?: string },
) {
  const owner = id.taskId
    ? await projection.entry(id.taskId)
    : await projection.session(id.contextId ?? "");
  if (
    !owner?.root ||
    !owner.subject ||
    (!reader.administrator && owner.subject !== reader.subject) ||
    (reader.systemOnly && owner.subject === reader.subject)
  )
    return undefined;
  return projection.graph([owner.root]);
}

type AgentRef = Pick<ResourceReference, "namespace" | "name"> | undefined;

const chatAgent = (namespace: string, entry: string, ref: AgentRef, identity: UserIdentity) =>
  ref?.namespace === namespace &&
  (ref.name === entry || (ref.name === "role-builder" && can(identity, Capability.AGENTS_MANAGE)));

/** A new execution uses the native Session's resource authorization and owner. */
export function executionTarget(namespace: string, ref: AgentRef, identity: UserIdentity) {
  if (
    ref?.namespace !== namespace ||
    !ref.name ||
    (ref.name === "role-builder" && !can(identity, Capability.AGENTS_MANAGE))
  )
    throw notFound("chat.invalidConversation");
}

export function chatTarget(
  namespace: string,
  entry: string,
  ref: AgentRef,
  identity: UserIdentity,
) {
  if (!chatAgent(namespace, entry, ref, identity)) throw notFound("chat.invalidConversation");
}

/** Existing engineer sessions are read-only views, with ownership checked by visibleGraph. */
export function conversationTarget(
  namespace: string,
  entry: string,
  ref: AgentRef,
  identity: UserIdentity,
  contextId: string,
) {
  if (chatAgent(namespace, entry, ref, identity)) return;
  if (ref?.namespace === namespace && contextId) return;
  throw notFound("chat.invalidConversation");
}
