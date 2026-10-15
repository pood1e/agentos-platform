import { clone, create } from "@bufbuild/protobuf";
import { ArtifactSchema, type StreamResponse, type Task, TaskSchema } from "../../gen/a2a_pb.js";

/** Applies one A2A stream event to the last known task. */
export function applyEvent(current: Task | undefined, event: StreamResponse): Task | undefined {
  const payload = event.payload;
  if (payload.case === "task") {
    if (
      current &&
      (payload.value.id !== current.id || payload.value.contextId !== current.contextId)
    )
      throw new Error("A2A task event changed task identity");
    return clone(TaskSchema, payload.value);
  }
  if (!current) return undefined;
  const next = clone(TaskSchema, current);
  if (payload.case === "statusUpdate") {
    if (payload.value.taskId !== next.id || payload.value.contextId !== next.contextId)
      throw new Error("A2A status event belongs to another task");
    for (const message of [next.status?.message, payload.value.status?.message]) {
      if (message && !next.history.some((item) => item.messageId === message.messageId))
        next.history.push(message);
    }
    next.status = payload.value.status;
  }
  if (payload.case === "artifactUpdate") {
    const update = payload.value;
    if (update.taskId !== next.id || update.contextId !== next.contextId)
      throw new Error("A2A artifact event belongs to another task");
    if (!update.artifact) return next;
    const incoming = clone(ArtifactSchema, update.artifact);
    const index = next.artifacts.findIndex((item) => item.artifactId === incoming.artifactId);
    const previous = next.artifacts[index];
    if (!previous) next.artifacts.push(incoming);
    else if (update.append)
      next.artifacts[index] = create(ArtifactSchema, {
        ...previous,
        ...incoming,
        metadata: { ...previous.metadata, ...incoming.metadata },
        parts: [...previous.parts, ...incoming.parts],
      });
    else next.artifacts[index] = incoming;
  }
  return next;
}
