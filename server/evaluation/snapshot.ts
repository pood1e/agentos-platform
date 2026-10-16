import { create, type JsonObject, toJson } from "@bufbuild/protobuf";
import type { CoreV1Api } from "@kubernetes/client-node";
import {
  ArtifactContentSchema,
  type ConfigurationSnapshot,
  ConfigurationSnapshotSchema,
  type EvaluationBaseline,
  type ResourceProposal,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { StructuredObjectSchema } from "../../gen/kagent/api/v1alpha1/common_pb.js";
import {
  type MemorySummary,
  MemorySummarySchema,
} from "../../gen/kagent/api/v1alpha1/memory_pb.js";
import { resource } from "../management/native.js";
import type { ResourceStore } from "../management/resources.js";
import { object, text } from "../read-model/decode/messages.js";
import { digest } from "../shared/change-digest.js";
import { secretArtifact, secretReferences } from "./references.js";

const kinds = [
  "templates",
  "agents",
  "harnesses",
  "models",
  "modelConfigs",
  "mcps",
  "remoteMCPs",
  "routes",
] as const;

export function configurationResource(value: JsonObject): JsonObject {
  const metadata = object(value.metadata);
  return {
    apiVersion: value.apiVersion ?? "",
    kind: value.kind ?? "",
    metadata: {
      name: metadata.name ?? "",
      namespace: metadata.namespace ?? "",
      uid: metadata.uid ?? "",
      generation: metadata.generation ?? 0,
      labels: metadata.labels ?? {},
      annotations: metadata.annotations ?? {},
    },
    ...(value.spec ? { spec: value.spec } : {}),
    ...(value.data ? { data: value.data } : {}),
  };
}

export interface SnapshotInputs {
  store: ResourceStore;
  core: CoreV1Api;
  workspace: string;
  platformImage: string;
  packImage: string;
  baseline: EvaluationBaseline;
  catalogName: string;
  knowledge: () => Promise<MemorySummary[]>;
  artifacts: ConfigurationSnapshot["artifacts"];
}

export function configurationSnapshots(inputs: SnapshotInputs) {
  return async (proposals: ResourceProposal[] = []) => {
    const [groups, skills, secrets, memories] = await Promise.all([
      Promise.all(kinds.map((kind) => inputs.store.list(kind))),
      inputs.store.readCatalog(),
      inputs.core.listNamespacedSecret({ namespace: inputs.workspace }),
      inputs.knowledge(),
    ]);
    const resources = groups
      .flat()
      .map(configurationResource)
      .sort((a, b) =>
        `${a.kind}/${text(object(a.metadata).name)}`.localeCompare(
          `${b.kind}/${text(object(b.metadata).name)}`,
        ),
      );
    resources.push({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: inputs.catalogName, namespace: inputs.workspace },
      data: { "catalog.json": skills.value },
    });
    const references = secretReferences([
      ...resources,
      ...proposals.flatMap((proposal) => proposal.resource?.value ?? []),
    ]);
    for (const proposal of proposals)
      if (proposal.resource?.kind === "Secret")
        references.delete(text(object(proposal.resource.value?.metadata).name));
    const credentials = secrets.items
      .filter((secret) => references.has(secret.metadata?.name ?? ""))
      .map(secretArtifact)
      .sort((a, b) => a.source.localeCompare(b.source));
    if (credentials.length !== references.size)
      throw new Error("A referenced credential is missing");
    const knowledge = memories
      .map((entry) => create(MemorySummarySchema, { ...entry, accessCount: 0n }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return create(ConfigurationSnapshotSchema, {
      workspace: inputs.workspace,
      platformImage: inputs.platformImage,
      packImage: inputs.packImage,
      resources: resources.map((value) => create(StructuredObjectSchema, resource(value))),
      proposals,
      baseline: inputs.baseline,
      artifacts: [
        ...inputs.artifacts,
        ...credentials.map((entry) => create(ArtifactContentSchema, entry)),
      ],
      knowledge,
      knowledgeDigest: digest(knowledge.map((entry) => toJson(MemorySummarySchema, entry))),
      credentialsDigest: digest(credentials),
    });
  };
}
