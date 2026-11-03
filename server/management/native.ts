import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import { invalid } from "../shared/errors.js";

/** Preserve native references while preventing editors from borrowing other services' credentials. */
export function credentialReferences(
  value: JsonValue | undefined,
  previous: JsonValue | undefined,
  managed?: { path: string; reference: JsonObject },
  path = "",
) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      credentialReferences(
        entry,
        Array.isArray(previous) ? previous[index] : undefined,
        managed,
        `${path}/${index}`,
      );
    });
  } else if (value && typeof value === "object") {
    const old =
      previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
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
}

/** The name of a reference that must stay within this workspace. */
export function localName(ref: ResourceReference | undefined, namespace: string) {
  if (!ref?.name || (ref.namespace && ref.namespace !== namespace))
    throw invalid("harness.invalidReference");
  return ref.name;
}
