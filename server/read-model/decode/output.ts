import { Role, type Task, TaskState } from "../../../gen/a2a_pb.js";
import { hitlPayload } from "./hitl.js";
import { messageText, partTypeKey, text } from "./messages.js";

/** Keeps visible progress across tool calls while identifying the final response separately. */
export function taskOutput(task: Task) {
  const blocks: string[] = [];
  let current = "";
  for (const part of task.artifacts.flatMap((artifact) => artifact.parts)) {
    const kind = text(part.metadata?.[partTypeKey]);
    if (kind === "function_call" || kind === "function_response") {
      if (current.trim()) blocks.push(current.trim());
      current = "";
    } else if (part.content.case === "text") current += part.content.value;
  }
  const final = current.trim();
  if (final) blocks.push(final);
  const history = messageText(
    task.history.findLast((message) => message.role === Role.AGENT && !hitlPayload(message)),
  );
  const failure = task.status?.state === TaskState.FAILED ? messageText(task.status.message) : "";
  if (failure && blocks.at(-1) !== failure) blocks.push(failure);
  const answer = failure || final || history;
  const completed = task.status?.state === TaskState.COMPLETED;
  if (completed && blocks.at(-1) === answer) blocks.pop();
  return { answer, progress: blocks.join("\n\n") || (completed ? "" : history) };
}
