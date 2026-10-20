import type { JsonObject, JsonValue } from "@bufbuild/protobuf";

export const text = (value: JsonValue | undefined) => (typeof value === "string" ? value : "");
export function object(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
