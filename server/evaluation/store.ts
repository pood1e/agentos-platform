import { create, fromJson, fromJsonString, toJson, toJsonString } from "@bufbuild/protobuf";
import { CoreV1Api, type KubeConfig, type V1ConfigMap } from "@kubernetes/client-node";
import {
  type Candidate,
  CandidateSchema,
  type ConfigurationSnapshot,
  ConfigurationSnapshotSchema,
  EvaluationJobInputSchema,
  type EvaluationReport,
  EvaluationReportSchema,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { redact } from "../../shared/redact.js";

export interface CandidateRecord {
  candidate: Candidate;
  snapshot: ConfigurationSnapshot;
  report?: EvaluationReport;
  metadata: V1ConfigMap;
}

/** Immutable inputs and API-owned publication state use native Kubernetes persistence. */
export class EvaluationStore {
  private api: CoreV1Api;
  constructor(
    config: KubeConfig,
    readonly namespace: string,
    private workspace: string,
  ) {
    this.api = config.makeApiClient(CoreV1Api);
  }

  readonly name = (id: string) => `candidate-${id}`;
  private labels = () => ({
    "agentos.dev/workspace": this.workspace,
    "agentos.dev/component": "evaluation",
  });

  async create(candidate: Candidate, snapshot: ConfigurationSnapshot): Promise<CandidateRecord> {
    if (Buffer.byteLength(toJsonString(ConfigurationSnapshotSchema, snapshot)) > 440_000)
      throw new Error("Candidate exceeds the immutable snapshot size limit");
    const name = this.name(candidate.id);
    const metadata = await this.api.createNamespacedConfigMap({
      namespace: this.namespace,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace: this.namespace, labels: this.labels() },
        data: { "candidate.json": toJsonString(CandidateSchema, candidate) },
      },
    });
    const ownerReferences = [
      { apiVersion: "v1", kind: "ConfigMap", name, uid: metadata.metadata?.uid ?? "" },
    ];
    await this.api.createNamespacedSecret({
      namespace: this.namespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        immutable: true,
        metadata: { name, namespace: this.namespace, labels: this.labels(), ownerReferences },
        stringData: {
          "private.json": toJsonString(ConfigurationSnapshotSchema, snapshot),
          "snapshot.json": toJsonString(
            EvaluationJobInputSchema,
            create(EvaluationJobInputSchema, {
              candidateId: candidate.id,
              bindingDigest: candidate.bindingDigest,
              snapshot: fromJson(
                ConfigurationSnapshotSchema,
                redact(toJson(ConfigurationSnapshotSchema, snapshot)),
              ),
            }),
          ),
        },
      },
    });
    await this.api.createNamespacedConfigMap({
      namespace: this.namespace,
      body: {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: `${name}-report`,
          namespace: this.namespace,
          labels: { ...this.labels(), "agentos.dev/report": "true" },
          ownerReferences,
        },
        data: {},
      },
    });
    return { candidate, snapshot, metadata };
  }

  async get(id: string): Promise<CandidateRecord> {
    const name = this.name(id);
    const [metadata, secret, report] = await Promise.all([
      this.api.readNamespacedConfigMap({ namespace: this.namespace, name }),
      this.api.readNamespacedSecret({ namespace: this.namespace, name }),
      this.api.readNamespacedConfigMap({ namespace: this.namespace, name: `${name}-report` }),
    ]);
    if (metadata.metadata?.labels?.["agentos.dev/workspace"] !== this.workspace)
      throw new Error("Candidate belongs to another workspace");
    const candidate = fromJsonString(CandidateSchema, metadata.data?.["candidate.json"] ?? "{}");
    const snapshot = fromJsonString(
      ConfigurationSnapshotSchema,
      Buffer.from(secret.data?.["private.json"] ?? "", "base64").toString(),
    );
    if (candidate.id !== id || snapshot.workspace !== this.workspace)
      throw new Error("Candidate identity differs from its snapshot");
    return {
      candidate,
      snapshot,
      metadata,
      report: report.data?.["report.json"]
        ? fromJsonString(EvaluationReportSchema, report.data["report.json"])
        : undefined,
    };
  }

  async list(): Promise<Candidate[]> {
    const result = await this.api.listNamespacedConfigMap({
      namespace: this.namespace,
      labelSelector: `agentos.dev/workspace=${this.workspace},agentos.dev/component=evaluation,!agentos.dev/report`,
    });
    return result.items.flatMap((item) =>
      item.data?.["candidate.json"]
        ? [fromJsonString(CandidateSchema, item.data["candidate.json"])]
        : [],
    );
  }

  async update(record: CandidateRecord, candidate: Candidate): Promise<CandidateRecord> {
    if (
      toJsonString(CandidateSchema, record.candidate) === toJsonString(CandidateSchema, candidate)
    )
      return { ...record, candidate };
    const metadata = await this.api.replaceNamespacedConfigMap({
      namespace: this.namespace,
      name: this.name(candidate.id),
      body: {
        ...record.metadata,
        data: {
          ...record.metadata.data,
          "candidate.json": toJsonString(CandidateSchema, candidate),
        },
      },
    });
    return { ...record, candidate, metadata };
  }

  async report(id: string, report: EvaluationReport): Promise<void> {
    const name = `${this.name(id)}-report`;
    const current = await this.api.readNamespacedConfigMap({ namespace: this.namespace, name });
    if (current.data?.["report.json"]) {
      if (current.data["report.json"] !== toJsonString(EvaluationReportSchema, report))
        throw new Error("A completed report cannot be replaced");
      return;
    }
    await this.api.replaceNamespacedConfigMap({
      namespace: this.namespace,
      name,
      body: { ...current, data: { "report.json": toJsonString(EvaluationReportSchema, report) } },
    });
  }

  async acknowledge(id: string): Promise<void> {
    const name = `${this.name(id)}-report`;
    const current = await this.api.readNamespacedConfigMap({ namespace: this.namespace, name });
    const report = fromJsonString(EvaluationReportSchema, current.data?.["report.json"] ?? "{}");
    if (!report.bindingDigest) throw new Error("Evaluation report is missing");
    if (report.feedbackSynchronized) return;
    report.feedbackSynchronized = true;
    await this.api.replaceNamespacedConfigMap({
      namespace: this.namespace,
      name,
      body: { ...current, data: { "report.json": toJsonString(EvaluationReportSchema, report) } },
    });
  }
}
