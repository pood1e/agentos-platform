import { createHash } from "node:crypto";
import { fromJson, type JsonObject, type JsonValue, toJson } from "@bufbuild/protobuf";
import { InteractionSchema } from "../../gen/agentos/console/v1/task_pb.js";
import { InvokeSessionOutputSchema } from "../../gen/kagent/api/v1/collaboration_pb.js";
import type { CallEntry } from "./calls.js";
import type { TaskEntry } from "./entry.js";

/** Stored form of a task entry; embedded protobuf messages keep their canonical JSON. */
export function encodeEntry(entry: TaskEntry): JsonObject {
  return JSON.parse(
    JSON.stringify({
      ...entry,
      calls: entry.calls.map((call) => ({
        ...call,
        delegation: call.delegation && {
          ...call.delegation,
          invocation:
            call.delegation.invocation &&
            toJson(InvokeSessionOutputSchema, call.delegation.invocation),
        },
      })),
      interactions: entry.interactions.map((item) => toJson(InteractionSchema, item)),
    }),
  );
}

export function decodeEntry(value: JsonObject): TaskEntry {
  const entry = value as unknown as TaskEntry;
  return {
    ...entry,
    calls: entry.calls.map(
      (call): CallEntry => ({
        ...call,
        delegation: call.delegation && {
          ...call.delegation,
          invocation:
            call.delegation.invocation &&
            fromJson(InvokeSessionOutputSchema, call.delegation.invocation as unknown as JsonValue),
        },
      }),
    ),
    interactions: (value.interactions as JsonValue[]).map((item) =>
      fromJson(InteractionSchema, item),
    ),
  };
}

/** Projection revision: the compact entry without its payload hash, so text-only writes are skipped. */
export function entryRevision(record: JsonObject): string {
  const { version: _version, ...projected } = record;
  return createHash("sha256").update(JSON.stringify(projected)).digest("base64url");
}
