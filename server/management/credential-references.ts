import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { invalid } from "../shared/errors.js";

/** Editors may retain native references, but cannot select another service's Secret. */
export function credentialReferences(
  value: JsonValue | undefined,
  previous: JsonValue | undefined,
  managed?: { path: string; reference: JsonObject },
  path = "",
) {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => {
      credentialReferences(
        entry,
        Array.isArray(previous) ? previous[i] : undefined,
        managed,
        `${path}/${i}`,
      );
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  const old = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  for (const [key, entry] of Object.entries(value)) {
    const location = `${path}/${key}`;
    if (["secretRef", "secretKeyRef", "apiKeySecret"].includes(key)) {
      if (
        !isDeepStrictEqual(entry, old[key]) &&
        !(managed?.path === location && isDeepStrictEqual(entry, managed.reference))
      )
        throw invalid("management.secretReferenceRequired");
    } else credentialReferences(entry, old[key], managed, location);
  }
}
