import type { JsonValue } from "@bufbuild/protobuf";
import type { V1Secret } from "@kubernetes/client-node";
import { digest } from "../shared/change-digest.js";

/** Native schemas express Secret references in these Kubernetes and kagent forms. */
export function secretReferences(value: JsonValue): Set<string> {
  const names = new Set<string>();
  function visit(value: JsonValue) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "apiKeySecret" && typeof item === "string") names.add(item);
      if (
        (key === "secretRef" || key === "secretKeyRef") &&
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof item.name === "string"
      )
        names.add(item.name);
      if (
        key === "valueFrom" &&
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.type === "Secret" &&
        typeof item.name === "string"
      )
        names.add(item.name);
      visit(item);
    }
  }
  visit(value);
  return names;
}

export function secretArtifact(secret: V1Secret) {
  return {
    source: `k8s-secret://${secret.metadata?.namespace}/${secret.metadata?.name}`,
    version: secret.metadata?.uid ?? "",
    path: "",
    sha256: digest(secret.data ?? {}),
  };
}
