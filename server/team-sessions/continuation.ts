// Delete once kagent dedicated subagents propagate nested HITL decisions to the caller.
import { create } from "@bufbuild/protobuf";
import { type Message, MessageSchema, Role, TaskState } from "../../gen/a2a_pb.js";
import { CoordinationJobSchema } from "../../gen/agentos/execution/v1/coordination_pb.js";
import type { Coordinator } from "../jobs/coordination.js";
import { hitlExtension } from "../read-model/decode/hitl.js";
import { parentTaskKey, resumedTaskKey } from "../read-model/decode/messages.js";
import type { TaskEntry } from "../read-model/entry.js";
import type { TaskIndex } from "../read-model/index.js";
import { terminal } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { foreground, taskTree } from "../read-model/tree.js";
import { waitingDelegations } from "../read-model/waiting.js";
import messages from "./messages.json" with { type: "json" };

interface Continuation {
  childId: string;
  tenant: string;
  message: Message;
}

function stoppedOperation(index: TaskIndex, parent: TaskEntry): boolean {
  const tree = taskTree(index, parent.id);
  if (tree && foreground(tree).some((entry) => entry.state === TaskState.CANCELED)) return true;
  const ancestors = index.relations().causalParents;
  const seen = new Set<string>();
  for (let entry: TaskEntry | undefined = parent; entry && !seen.has(entry.id); ) {
    if ([TaskState.CANCELED, TaskState.REJECTED].includes(entry.state)) return true;
    seen.add(entry.id);
    entry = index.entry(ancestors.get(entry.id) ?? "");
  }
  return false;
}

function continuation(index: TaskIndex, parent: TaskEntry, childId: string) {
  const { resumed } = index.relations();
  const child = index.entry(childId);
  if (!child || !terminal(child.state) || resumed.has(child.id)) return undefined;
  const tree = taskTree(index, child.id);
  const active = tree ? foreground(tree) : [];
  if (active.some((entry) => !terminal(entry.state))) return undefined;
  if (active.some((entry) => waitingDelegations(index, entry).some((id) => !resumed.has(id))))
    return undefined;
  const decided = active
    .filter((entry) => entry.decision)
    .sort((a, b) => (b.statusAt ?? 0) - (a.statusAt ?? 0))[0]?.decision;
  const result = tree?.latest ?? child;
  const language = /\p{Script=Han}/u.test(parent.prompt) ? "zh-CN" : "en";
  const summary =
    language === "zh-CN"
      ? Array.from(result.answer).slice(0, 180).join("")
      : result.answer.split(/\s+/).slice(0, 80).join(" ");
  const message = messages[language]
    .replace("{state}", TaskState[result.state])
    .replace("{task}", result.id)
    .replace("{result}", summary);
  return {
    childId: child.id,
    tenant: parent.agentId,
    message: create(MessageSchema, {
      messageId: `resume-${child.id}-${decided?.messageId ?? result.id}`,
      contextId: parent.contextId,
      role: Role.USER,
      extensions: [hitlExtension],
      metadata: { [parentTaskKey]: parent.id, [resumedTaskKey]: child.id },
      parts: [
        {
          content: {
            case: "text",
            value: message,
          },
        },
      ],
    }),
  } satisfies Continuation;
}

/** Returns nested HITL outcomes using kagent's idempotent message identity. */
export function continuations(
  sync: KagentSync,
  authorize?: (parentContext: string, contexts: string[]) => Promise<void>,
): Coordinator {
  const index = sync.index;
  return {
    name: "continuations",
    select(changed) {
      const ids = new Set(changed);
      const parents = index.relations().causalParents;
      for (const id of ids) {
        const parent = parents.get(id);
        if (parent) ids.add(parent);
      }
      return [...ids].flatMap((id) => {
        const parent = index.entry(id);
        if (!parent || !terminal(parent.state) || stoppedOperation(index, parent)) return [];
        return waitingDelegations(index, parent).flatMap((childId) =>
          continuation(index, parent, childId)
            ? [
                create(CoordinationJobSchema, {
                  taskId: parent.id,
                  work: { case: "childId", value: childId },
                }),
              ]
            : [],
        );
      });
    },
    async run(reference) {
      const parent = index.entry(reference.taskId);
      if (!parent || reference.work.case !== "childId" || stoppedOperation(index, parent)) return;
      const next = continuation(index, parent, reference.work.value);
      if (!next) return;
      await authorize?.(
        parent.contextId,
        (taskTree(index, reference.work.value)?.entries ?? []).map((entry) => entry.contextId),
      );
      // Authorization and native lifecycle are checked again after an offline grant refresh.
      if (stoppedOperation(index, parent) || !continuation(index, parent, reference.work.value))
        return;
      await sync.send(next.tenant, next.message);
      return;
    },
  };
}
