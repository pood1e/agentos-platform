import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { type Timestamp, timestampMs } from "@bufbuild/protobuf/wkt";
import type { Message, Part, Task } from "../../../gen/a2a_pb.js";

export const timelineKey = "kagent.dev/a2a/timeline-position";
export const partTypeKey = "kagent.dev/a2a/part-type";
export const createdAtKey = "kagent.dev/a2a/task-created-at";
export const parentTaskKey = "agentos.dev/parent-task";
export const resumedTaskKey = "agentos.dev/resumed-task";
export const intentKey = "agentos.dev/intent";

export { object, text } from "../../../shared/json.js";

import { text } from "../../../shared/json.js";

export function partsText(parts: Part[]): string {
  return parts
    .flatMap((part) => (part.content.case === "text" ? [part.content.value] : []))
    .join("\n")
    .trim();
}

export const messageText = (message?: Message) => (message ? partsText(message.parts) : "");

function isoMillis(value: JsonValue | undefined): number | undefined {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

export const timeline = (metadata?: JsonObject) => isoMillis(metadata?.[timelineKey]);

export const millis = (timestamp?: Timestamp) => (timestamp ? timestampMs(timestamp) : undefined);

export const statusMillis = (task: Task) => millis(task.status?.timestamp);

export const createdMillis = (task: Task) => isoMillis(task.metadata?.[createdAtKey]);

export const metadataText = (message: Message, key: string) => text(message.metadata?.[key]);
