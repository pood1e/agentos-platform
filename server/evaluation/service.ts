import { randomUUID } from "node:crypto";
import { clone, create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import {
  CandidateSchema,
  CandidateState,
  type ConfigurationSnapshot,
  type EvaluationService,
  type ResourceProposal,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import { accessProfile } from "../platform/authorization.js";
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
}

export function evaluationService(
  dependencies: EvaluationDependencies,
): ServiceImpl<typeof EvaluationService> {
  const { store, jobs, freeze, validate, prepare, publish } = dependencies;
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
      if (
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
      return { candidate: (await current(id)).candidate };
    },
    async createCandidate(request, context) {
      await validate(request.proposals);
      const snapshot = await freeze(request.proposals);
      if (!snapshot.baseline)
        throw new ConnectError("Evaluation baseline is required", Code.FailedPrecondition);
      const candidate = create(CandidateSchema, {
        id: randomUUID(),
        name: request.name,
        bindingDigest: snapshotDigest(snapshot),
        state: CandidateState.DRAFT,
        createdAt: timestampFromMs(Date.now()),
        createdBy: context.values.get(accessProfile).subject,
        baseline: snapshot.baseline.name,
        baselineVersion: snapshot.baseline.version,
        packImage: snapshot.packImage,
        platformImage: snapshot.platformImage,
      });
      return { candidate: (await store.create(candidate, snapshot)).candidate };
    },
    async runEvaluation({ id }) {
      const record = await current(id);
      if (record.candidate.state === CandidateState.RUNNING) {
        await jobs.start(record);
        return { candidate: record.candidate };
      }
      if (record.candidate.state !== CandidateState.DRAFT)
        throw new ConnectError(
          "Create a new candidate for changed inputs or a new attempt",
          Code.FailedPrecondition,
        );
      await prepare(record);
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
        record.candidate.state !== CandidateState.PASSED ||
        bindingDigest !== record.candidate.bindingDigest
      )
        throw new ConnectError(
          "Publication requires a current passing evaluation",
          Code.FailedPrecondition,
        );
      const publishing = await store.update(record, {
        ...record.candidate,
        state: CandidateState.PUBLISHING,
      });
      await publish(publishing);
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
