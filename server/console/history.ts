import { create } from "@bufbuild/protobuf";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1alpha1/common_pb.js";
import { SessionSchema } from "../../gen/kagent/api/v1alpha1/sessions_pb.js";
import { can } from "../../shared/permissions.js";
import type { Executions } from "../authorization/executions.js";
import { scheduledExecutionId } from "../automation/identity.js";
import { agentKey } from "../read-model/agents.js";
import { TaskIndex } from "../read-model/index.js";
import { notFound } from "../shared/errors.js";

/** Read access survives cancellation and credential expiry; it never grants execution authority. */
export function executionHistory(index: TaskIndex, executions?: Executions) {
  return async (identity: ExecutionIdentity) => {
    if (!executions) return index;
    const scheduled = new Map(
      index
        .all()
        .filter((entry) => entry.messageIds.some(scheduledExecutionId))
        .map((entry) => [entry.contextId, entry]),
    );
    const origins = [...scheduled.values()].map((entry) => {
      const [namespace = "", name = ""] = entry.agentId.split("/");
      return create(SessionSchema, {
        id: entry.contextId,
        agent: { namespace, name },
      });
    });
    const bindings = await executions.history(
      identity.subject,
      [
        ...new Set([
          ...index.sessions().map((session) => session.id),
          ...index.all().map((entry) => entry.contextId),
        ]),
      ],
      origins,
    );
    const contexts = new Set(
      bindings
        .filter((binding) => index.session(binding.sessionId)?.agentId === agentKey(binding.agent))
        .map((binding) => binding.sessionId),
    );
    const view = new TaskIndex();
    view.setAgents(index.agents());
    for (const session of index.sessions()) if (contexts.has(session.id)) view.setSession(session);
    for (const entry of index.all()) if (contexts.has(entry.contextId)) view.upsert(entry);
    return view;
  };
}

export function chatTarget(
  namespace: string,
  entry: string,
  ref: Pick<ResourceReference, "namespace" | "name"> | undefined,
  identity: ExecutionIdentity,
) {
  if (
    ref?.namespace !== namespace ||
    (ref.name !== entry &&
      !(ref.name === "role-builder" && can(identity, Capability.AGENTS_MANAGE)))
  )
    throw notFound("chat.invalidConversation");
}
