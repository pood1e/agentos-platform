import { Code, ConnectError } from "@connectrpc/connect";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import { isAdministrator } from "../../shared/permissions.js";
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
 * The conversation anchoring the execution tree of a task or conversation the identity may read.
 * Read access survives cancellation and credential expiry; it never grants execution authority.
 */
export async function visibleAnchor(
  projection: Pick<TaskQueries, "entry" | "session">,
  reader: Viewer,
  id: { taskId?: string; contextId?: string },
  signal?: AbortSignal,
) {
  const owner = id.taskId
    ? await projection.entry(id.taskId, signal)
    : await projection.session(id.contextId ?? "", signal);
  if (
    !owner?.root ||
    !owner.subject ||
    (!reader.administrator && owner.subject !== reader.subject) ||
    (reader.systemOnly && owner.subject === reader.subject)
  )
    return undefined;
  return "contextId" in owner ? owner.contextId : owner.id;
}

export async function visibleGraph(
  projection: Pick<TaskQueries, "entry" | "session" | "graph">,
  reader: Viewer,
  id: { taskId?: string; contextId?: string },
  signal?: AbortSignal,
) {
  const anchor = await visibleAnchor(projection, reader, id, signal);
  return anchor ? projection.graph(anchor, signal) : undefined;
}

type AgentRef = Pick<ResourceReference, "namespace" | "name"> | undefined;

const chatAgent = (namespace: string, entry: string, ref: AgentRef) =>
  ref?.namespace === namespace && ref.name === entry;

/** A new execution uses the native Session's resource authorization and owner. */
export function executionTarget(namespace: string, ref: AgentRef) {
  if (ref?.namespace !== namespace || !ref.name) throw notFound("chat.invalidConversation");
}

export function chatTarget(namespace: string, entry: string, ref: AgentRef) {
  if (!chatAgent(namespace, entry, ref)) throw notFound("chat.invalidConversation");
}

/** Existing Agent sessions are read-only views, with ownership checked by visibleGraph. */
export function conversationTarget(
  namespace: string,
  entry: string,
  ref: AgentRef,
  contextId: string,
) {
  if (chatAgent(namespace, entry, ref)) return;
  if (ref?.namespace === namespace && contextId) return;
  throw notFound("chat.invalidConversation");
}
