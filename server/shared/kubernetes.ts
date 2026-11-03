import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ApiException, type V1ObjectMeta } from "@kubernetes/client-node";
import { conflict, fail, invalid, notFound } from "./errors.js";

/** Maps a Kubernetes client failure to the console's localized errors. */
export function resourceError(error: unknown): never {
  if (error instanceof ConnectError) throw error;
  if (error instanceof ApiException) {
    if (error.code === 409) throw conflict("configuration.conflict");
    if (error.code === 404) throw notFound("management.notFound");
    if (error.code === 400 || error.code === 422) throw invalid("management.invalid");
  }
  throw fail(Code.Unavailable, "management.unavailable");
}

const presetOwner = (owner: { apiVersion?: unknown; kind?: unknown } | null) =>
  owner?.apiVersion === "agentos.dev/v1alpha1" && owner.kind === "Preset";

/** Takes a resource out of Preset management: the controller then leaves user edits in place. */
export function userOwned<T extends JsonObject | V1ObjectMeta>(metadata: T): T {
  const { annotations, ownerReferences } = metadata as {
    annotations?: object;
    ownerReferences?: unknown;
  };
  return {
    ...metadata,
    annotations: { ...annotations, "agentos.dev/ownership": "user" },
    ...(Array.isArray(ownerReferences)
      ? { ownerReferences: ownerReferences.filter((owner) => !presetOwner(owner)) }
      : {}),
  } as T;
}
