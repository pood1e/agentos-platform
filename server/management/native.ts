import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { object, text } from "../read-model/decode/messages.js";
import { invalid } from "../shared/errors.js";
import type { ResourceKind, ResourceStore } from "./resources.js";
export interface GatewayConfig {
  name: string;
  url: string;
  mcpUrl: string;
  namespace: string;
  secret: string;
}
export const meta = (value: JsonObject) => object(value.metadata);
export function userResource(value: JsonObject): JsonObject {
  const metadata = meta(value);
  const owners = metadata.ownerReferences;
  return {
    ...value,
    metadata: {
      ...metadata,
      annotations: { ...object(metadata.annotations), "agentos.dev/ownership": "user" },
      ...(Array.isArray(owners)
        ? {
            ownerReferences: owners.filter(
              (owner) =>
                !(
                  object(owner).apiVersion === "agentos.dev/v1alpha1" &&
                  object(owner).kind === "Preset"
                ),
            ),
          }
        : {}),
    },
  };
}

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
export const resource = (value: JsonObject) => ({
  apiVersion: text(value.apiVersion),
  kind: text(value.kind),
  value,
});

export async function optional(store: ResourceStore, kind: ResourceKind, name: string) {
  try {
    return await store.get(kind, name);
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
    throw error;
  }
}
