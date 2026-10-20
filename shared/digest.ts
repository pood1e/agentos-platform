import { createHash } from "node:crypto";
import type { JsonValue } from "@bufbuild/protobuf";
import canonicalize from "canonicalize";

export function digest(value: JsonValue): string {
  const json = canonicalize(value);
  if (json === undefined) throw new Error("Payload must be JSON");
  return createHash("sha256").update(json).digest("hex");
}
