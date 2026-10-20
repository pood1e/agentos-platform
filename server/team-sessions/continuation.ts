// Delete once kagent dedicated subagents propagate nested HITL decisions to the caller.
import { create } from "@bufbuild/protobuf";
import type { FastifyBaseLogger } from "fastify";
import { type Message, MessageSchema, Role, TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { hitlExtension } from "../read-model/decode/hitl.js";
import { parentTaskKey, resumedTaskKey } from "../read-model/decode/messages.js";
import type { TaskEntry } from "../read-model/entry.js";
import type { TaskIndex } from "../read-model/index.js";
import { terminal } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { foreground, taskTree } from "../read-model/tree.js";
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

const waiting = (index: TaskIndex, entry: TaskEntry) =>
  entry.calls.flatMap((call) => {
    const invocation = call.delegation?.invocation;
    const childId = invocation?.taskId || index.target(entry, call);
    if (!childId) return [];
    if (!invocation && (call.state === ActivityState.FAILED || !call.returned)) return [childId];
    if (!invocation) return [];
    if (invocation.state === TaskState.INPUT_REQUIRED) return [invocation.taskId];
    const child = index.entry(invocation.taskId);
    const continued =
      child &&
      (index.relations().continuations.get(child.id) ?? []).some((id) => {
        const next = index.entry(id);
        return (
          next?.agentId === child.agentId &&
          next.contextId === child.contextId &&
          next.resumedTaskId
        );
      });
    return continued ? [invocation.taskId] : [];
  });

function continuation(index: TaskIndex, parent: TaskEntry, childId: string) {
  const { resumed } = index.relations();
  const child = index.entry(childId);
  if (!child || !terminal(child.state) || resumed.has(child.id)) return undefined;
  const tree = taskTree(index, child.id);
  const active = tree ? foreground(tree) : [];
  if (active.some((entry) => !terminal(entry.state))) return undefined;
  if (active.some((entry) => waiting(index, entry).some((id) => !resumed.has(id))))
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

/**
 * Returns a child's result to the calling session after its human decision.
 * Deterministic message IDs make a resend idempotent in kagent.
 */
export function startContinuations(
  sync: KagentSync,
  log: FastifyBaseLogger,
  authorize?: (parentContext: string, contexts: string[]) => Promise<void>,
): () => void {
  const index = sync.index;
  const sending = new Set<string>();
  const retries = new Map<string, { attempts: number; after: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => {
    clearTimeout(timer);
    const due = [...retries].filter(([id]) => !sending.has(id)).map(([, retry]) => retry.after);
    if (!stopped && due.length) timer = setTimeout(run, Math.max(0, Math.min(...due) - Date.now()));
  };
  const run = () => {
    if (stopped) return;
    const waitingIds = new Set<string>();
    for (const parent of index.all()) {
      if (!terminal(parent.state) || stoppedOperation(index, parent)) continue;
      for (const childId of waiting(index, parent)) {
        const next = continuation(index, parent, childId);
        waitingIds.add(childId);
        if (!next) {
          retries.delete(childId);
          continue;
        }
        const retry = retries.get(childId);
        if (sending.has(childId) || (retry && retry.after > Date.now())) continue;
        sending.add(childId);
        Promise.resolve()
          .then(async () => {
            await authorize?.(
              parent.contextId,
              (taskTree(index, childId)?.entries ?? []).map((entry) => entry.contextId),
            );
            if (!stopped) await sync.send(next.tenant, next.message);
          })
          .then(() => retries.delete(childId))
          .catch((error: unknown) => {
            const attempts = (retry?.attempts ?? 0) + 1;
            retries.set(childId, {
              attempts,
              after: Date.now() + Math.min(5_000 * 2 ** attempts, 300_000),
            });
            log.warn({ err: error, taskId: childId }, "Delegation continuation failed");
          })
          .finally(() => {
            sending.delete(childId);
            schedule();
          });
      }
    }
    for (const id of retries.keys()) if (!waitingIds.has(id)) retries.delete(id);
    schedule();
  };
  run();
  const unsubscribe = index.onChange(run);
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
