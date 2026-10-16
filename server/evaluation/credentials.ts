import type { JsonObject } from "@bufbuild/protobuf";
import type { CoreV1Api } from "@kubernetes/client-node";
import { meta } from "../management/native.js";
import { object, text } from "../read-model/decode/messages.js";
import { secretReferences } from "./references.js";
import type { CandidateRecord } from "./store.js";
import { variantName } from "./variants.js";

export function sandboxCredentials(
  core: CoreV1Api,
  workspace: string,
  namespace: string,
  apply: (value: JsonObject, candidate: string) => Promise<unknown>,
) {
  async function copyCredentials(value: JsonObject, prefix: string, record: CandidateRecord) {
    const originals = secretReferences(
      record.snapshot.resources.flatMap((entry) => entry.value ?? []),
    );
    for (const proposal of record.snapshot.proposals)
      if (proposal.resource?.kind === "Secret")
        originals.add(text(meta(proposal.resource.value ?? {}).name));
    const references = new Map<string, Set<string>>();
    function visit(value: unknown) {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        const ref = object(item);
        if (
          (key === "secretRef" ||
            key === "secretKeyRef" ||
            (key === "valueFrom" && ref.type === "Secret")) &&
          text(ref.name).startsWith(prefix)
        ) {
          const name = [...originals].find((name) => variantName(prefix, name) === ref.name);
          if (!name) throw new Error("Credential is outside the frozen snapshot");
          const keys = references.get(name) ?? new Set<string>();
          keys.add(text(ref.key) || "Authorization");
          references.set(name, keys);
        }
        visit(item);
      }
    }
    visit(value.spec);
    for (const [name, selected] of references) {
      const proposed = record.snapshot.proposals.find(
        (proposal) =>
          proposal.resource?.kind === "Secret" && meta(proposal.resource.value ?? {}).name === name,
      )?.resource?.value;
      const current = proposed
        ? {
            data: Object.fromEntries(
              Object.entries(object(proposed.stringData)).map(([key, value]) => [
                key,
                Buffer.from(text(value)).toString("base64"),
              ]),
            ),
          }
        : await core.readNamespacedSecret({ namespace: workspace, name });
      const data = Object.fromEntries(
        [...selected].map((key) => {
          if (!current.data?.[key]) throw new Error("Evaluation credential key is missing");
          return [key, current.data[key]];
        }),
      );
      await apply(
        {
          apiVersion: "v1",
          kind: "Secret",
          type: "Opaque",
          metadata: { name: variantName(prefix, name), namespace },
          data,
        },
        record.candidate.id,
      );
    }
  }
  return copyCredentials;
}
