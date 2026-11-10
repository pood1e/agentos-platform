import { toJson } from "@bufbuild/protobuf";
import { type Value, ValueSchema } from "@bufbuild/protobuf/wkt";
import { redact } from "./redact.js";

/** JSON values, including JSON documents carried as text, formatted for reading. */
export function pretty(value?: Value): string | undefined {
  if (!value) return undefined;
  const json = toJson(ValueSchema, value);
  if (typeof json !== "string") return JSON.stringify(redact(json), null, 2);
  try {
    return JSON.stringify(redact(JSON.parse(json)), null, 2);
  } catch {
    return json;
  }
}
