import { create } from "@bufbuild/protobuf";
import { ApiException, type CoreV1Api } from "@kubernetes/client-node";
import { MemorySummarySchema } from "../../gen/kagent/api/v1alpha1/memory_pb.js";
import { digest } from "../../shared/digest.js";
import type { KagentClients } from "../kagent/clients.js";
import { type KnowledgeConfig, knowledgeService } from "../knowledge/service.js";
import type { CandidateRecord } from "./store.js";

/** Persist each embedding once so both variants use byte-identical vectors, including after restart. */
export function frozenKnowledge(
  core: CoreV1Api,
  native: KagentClients,
  namespace: string,
  config: KnowledgeConfig,
) {
  const embedding = knowledgeService(native, config);
  return async (record: CandidateRecord, target: KnowledgeConfig) => {
    const memories = [
        ...record.snapshot.knowledge,
        ...(record.snapshot.baseline?.knowledgeSeed ?? []).map((content) =>
          create(MemorySummarySchema, { id: `scenario:${digest(content)}`, content }),
        ),
      ],
      vectors: number[][] = [];
    for (let offset = 0; offset < memories.length; offset += 128) {
      const entries = memories.slice(offset, offset + 128);
      const name = `candidate-${record.candidate.id}-knowledge-${offset / 128}`;
      const binding = digest(entries.map((entry) => ({ id: entry.id, content: entry.content })));
      let secret = await core.readNamespacedSecret({ namespace, name }).catch((error: unknown) => {
        if (error instanceof ApiException && error.code === 404) return undefined;
        throw error;
      });
      if (!secret) {
        const bytes = Buffer.alloc(entries.length * 768 * 4);
        for (const [index, entry] of entries.entries())
          (await embedding.vector(entry.content)).forEach((value, i) => {
            bytes.writeFloatLE(value, (index * 768 + i) * 4);
          });
        secret = await core.createNamespacedSecret({
          namespace,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            immutable: true,
            metadata: {
              name,
              namespace,
              labels: { "agentos.dev/candidate": record.candidate.id },
              annotations: { "agentos.dev/binding": binding },
              ownerReferences: [
                {
                  apiVersion: "v1",
                  kind: "ConfigMap",
                  name: `candidate-${record.candidate.id}`,
                  uid: record.metadata.metadata?.uid ?? "",
                },
              ],
            },
            data: { vectors: bytes.toString("base64") },
          },
        });
      }
      const bytes = Buffer.from(secret.data?.vectors ?? "", "base64");
      if (
        secret.metadata?.annotations?.["agentos.dev/binding"] !== binding ||
        bytes.length !== entries.length * 768 * 4
      )
        throw new Error("Frozen evaluation embeddings differ from their knowledge");
      entries.forEach((_entry, index) => {
        vectors.push(
          Array.from({ length: 768 }, (_unused, i) => bytes.readFloatLE((index * 768 + i) * 4)),
        );
      });
    }
    const existing = await native.memory.list(target.scope, { timeoutMs: 15_000 });
    if (!existing.memories.length && memories.length)
      await native.memory.addSessionBatch(
        {
          items: memories.map((entry, index) => ({
            ...target.scope,
            content: entry.content,
            vector: vectors[index],
            metadata: { source: entry.id },
          })),
        },
        { timeoutMs: 30_000 },
      );
    else if (
      existing.memories
        .map((entry) => entry.content)
        .sort()
        .join("\0") !==
      memories
        .map((entry) => entry.content)
        .sort()
        .join("\0")
    )
      throw new Error("Evaluation knowledge changed before execution");
  };
}
