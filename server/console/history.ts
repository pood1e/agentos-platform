import { create } from "@bufbuild/protobuf";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import { SessionSchema } from "../../gen/kagent/api/v1/sessions_pb.js";
import { can, isAdministrator } from "../../shared/permissions.js";
import type { Executions } from "../authorization/executions.js";
import { scheduledExecutionId } from "../automation/identity.js";
import { agentKey } from "../read-model/agents.js";
import { TaskIndex } from "../read-model/index.js";
import { notFound } from "../shared/errors.js";

/** Read access survives cancellation and credential expiry; it never grants execution authority. */
export function executionHistory(index: TaskIndex, executions?: Executions) {
  return async (
    identity: ExecutionIdentity,
    systemOnly = false,
    contexts?: ReadonlySet<string>,
  ) => {
    if (!executions) return systemOnly ? new TaskIndex() : index;
    const sessions = contexts
      ? [...contexts].flatMap((id) => index.session(id) ?? [])
      : index.sessions();
    const entries = contexts
      ? [...contexts].flatMap((id) => index.contextEntries(id))
      : index.all();
    const scheduled = new Map(
      entries
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
          ...sessions.map((session) => session.id),
          ...entries.map((entry) => entry.contextId),
        ]),
      ],
      origins,
    );
    const visible = new Set(
      bindings
        .filter(
          (binding) =>
            (!systemOnly && binding.subject === identity.subject) ||
            (binding.subject.startsWith("service:") && isAdministrator(identity)),
        )
        .filter((binding) => index.session(binding.sessionId)?.agentId === agentKey(binding.agent))
        .map((binding) => binding.sessionId),
    );
    const view = new TaskIndex();
    view.setAgents(index.agents());
    for (const session of sessions) if (visible.has(session.id)) view.setSession(session);
    for (const entry of entries) if (visible.has(entry.contextId)) view.upsert(entry);
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
