import { randomUUID } from "node:crypto";
import { clone, create, fromJson, toJson } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import {
  CandidateSchema,
  CandidateState,
  type ConfigurationSnapshot,
  ConfigurationSnapshotSchema,
  type EvaluationService,
  type ResourceProposal,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { redact } from "../../shared/redact.js";
import { evaluationFailures, snapshotDigest } from "./gate.js";
import type { evaluationJobs } from "./jobs.js";
import type { CandidateRecord, EvaluationStore } from "./store.js";

export interface EvaluationDependencies {
  store: EvaluationStore;
  jobs: ReturnType<typeof evaluationJobs>;
  freeze: (proposals?: ResourceProposal[]) => Promise<ConfigurationSnapshot>;
  validate: (proposals: ResourceProposal[]) => Promise<void>;
  prepare: (record: CandidateRecord) => Promise<void>;
  publish: (record: CandidateRecord) => Promise<void>;
  published?: () => Promise<void>;
  ready?: (record: CandidateRecord) => Promise<boolean>;
  dispose?: (id: string) => Promise<void>;
}

export function candidateDrafts({ store, freeze, validate }: EvaluationDependencies) {
  return async (name: string, proposals: ResourceProposal[], createdBy: string) => {
    if (!proposals.length || proposals.length > 64 || !createdBy)
      throw new ConnectError("Candidate changes and author are required", Code.InvalidArgument);
    await validate(proposals);
    const snapshot = await freeze(proposals);
    if (!snapshot.baseline)
      throw new ConnectError("Evaluation baseline is required", Code.FailedPrecondition);
    const candidate = create(CandidateSchema, {
      id: randomUUID(),
      name: name.slice(0, 80),
      bindingDigest: snapshotDigest(snapshot),
      state: CandidateState.DRAFT,
      createdAt: timestampFromMs(Date.now()),
      createdBy,
      baseline: snapshot.baseline.name,
      baselineVersion: snapshot.baseline.version,
      packImage: snapshot.packImage,
      platformImage: snapshot.platformImage,
    });
    return (await store.create(candidate, snapshot)).candidate;
  };
}

export function evaluationService(
  dependencies: EvaluationDependencies,
): Required<ServiceImpl<typeof EvaluationService>> {
  const { store, jobs, freeze, prepare, publish } = dependencies;
  async function current(id: string) {
    const record = await store.get(id);
    const candidate = clone(CandidateSchema, record.candidate);
    if ([CandidateState.PUBLISHED, CandidateState.PUBLISHING].includes(candidate.state))
      return record;
    if (snapshotDigest(record.snapshot) !== candidate.bindingDigest)
      throw new ConnectError("Candidate snapshot differs from its identity", Code.DataLoss);
    const fresh = await freeze(record.snapshot.proposals);
    if (snapshotDigest(fresh) !== candidate.bindingDigest) {
      candidate.state = CandidateState.STALE;
      candidate.failures = ["evaluation.bindingChanged"];
    } else if (candidate.jobName) {
      const job = await jobs.get(id);
      if (!job) {
        candidate.state = CandidateState.FAILED;
        candidate.failures = ["evaluation.jobMissing"];
      } else if (
        job?.status?.conditions?.some(
          (condition) => condition.type === "Failed" && condition.status === "True",
        )
      ) {
        candidate.state = CandidateState.FAILED;
        candidate.failures = [
          "evaluation.jobFailed",
          ...evaluationFailures(record.snapshot, record.report),
        ];
      } else if (
        job?.status?.conditions?.some(
          (condition) => condition.type === "Complete" && condition.status === "True",
        )
      ) {
        candidate.failures = evaluationFailures(record.snapshot, record.report);
        candidate.state = candidate.failures.length ? CandidateState.FAILED : CandidateState.PASSED;
      } else candidate.state = CandidateState.RUNNING;
    }
    candidate.report = record.report;
    return store.update(record, candidate);
  }
  return {
    async listCandidates() {
      const records = await store.list();
      const candidates = await Promise.all(
        records.map(async (record) => (await current(record.id)).candidate),
      );
      return { candidates };
    },
    async getCandidate({ id }) {
      const record = await current(id);
      return {
        candidate: record.candidate,
        snapshot: fromJson(
          ConfigurationSnapshotSchema,
          redact(toJson(ConfigurationSnapshotSchema, record.snapshot)),
        ),
      };
    },
    async runEvaluation({ id }) {
      const record = await current(id);
      if (record.candidate.state === CandidateState.RUNNING) return { candidate: record.candidate };
      if (record.candidate.state !== CandidateState.DRAFT)
        throw new ConnectError(
          "Create a new candidate for changed inputs or a new attempt",
          Code.FailedPrecondition,
        );
      try {
        await prepare(record);
      } catch (error) {
        await store.update(record, {
          ...record.candidate,
          state: CandidateState.FAILED,
          failures: ["evaluation.setupFailed"],
        });
        await dependencies.dispose?.(id);
        throw new ConnectError(
          "Evaluation setup failed",
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      }
      const running = await store.update(record, {
        ...record.candidate,
        state: CandidateState.RUNNING,
        jobName: jobs.name(id),
      });
      await jobs.start(running);
      return { candidate: running.candidate };
    },
    async publishCandidate({ id, bindingDigest }) {
      const record = await current(id);
      if (
        record.candidate.state === CandidateState.PUBLISHED &&
        bindingDigest === record.candidate.bindingDigest
      )
        return { candidate: record.candidate };
      if (
        ![CandidateState.PASSED, CandidateState.PUBLISHING].includes(record.candidate.state) ||
        bindingDigest !== record.candidate.bindingDigest
      )
        throw new ConnectError(
          "Publication requires a current passing evaluation",
          Code.FailedPrecondition,
        );
      const publishing =
        record.candidate.state === CandidateState.PUBLISHING
          ? record
          : await store.update(record, { ...record.candidate, state: CandidateState.PUBLISHING });
      await publish(publishing);
      if (dependencies.ready && !(await dependencies.ready(publishing)))
        return { candidate: publishing.candidate };
      const response = {
        candidate: (
          await store.update(publishing, {
            ...publishing.candidate,
            state: CandidateState.PUBLISHED,
          })
        ).candidate,
      };
      await dependencies.published?.();
      return response;
    },
  };
}
