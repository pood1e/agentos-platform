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
  return { answer: failure || final || history, response: blocks.join("\n\n") || history };
}
