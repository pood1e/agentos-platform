import { clone, create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import {
  CandidateSchema,
  CandidateState,
  ConfigurationSnapshotSchema,
  EvaluationReportSchema,
  EvaluationService,
} from "../gen/agentos/evaluation/v1/evaluation_pb.js";
import { snapshotDigest } from "../server/evaluation/gate.js";
import type { EvaluationDependencies } from "../server/evaluation/service.js";
import { evaluationService } from "../server/evaluation/service.js";
import type { CandidateRecord } from "../server/evaluation/store.js";

function fixture() {
  const snapshot = create(ConfigurationSnapshotSchema, {
    workspace: "operations",
    baseline: {
      name: "baseline",
      version: "1",
      repetitions: 1,
      samples: [{ id: "holdout", split: "holdout" }],
      rules: [{ name: "correctness", minimum: 0.8, maximumRegression: 0 }],
    },
  });
  let record: CandidateRecord = {
    snapshot: clone(ConfigurationSnapshotSchema, snapshot),
    candidate: create(CandidateSchema, {
      id: "8305aa3c-c01c-4882-8d30-3c72ce98f024",
      bindingDigest: snapshotDigest(snapshot),
      state: CandidateState.DRAFT,
    }),
    metadata: {},
  };
  const job = { status: { conditions: [{ type: "Complete", status: "True" }] } };
  const publish = vi.fn(async () => {}),
    ready = vi.fn(async () => true);
  const getJob = vi.fn(async () => job);
  const dependencies = {
    store: {
      get: async () => record,
      list: async () => [record.candidate],
      update: async (_original: CandidateRecord, candidate: CandidateRecord["candidate"]) => {
        record = { ...record, candidate };
        return record;
      },
    },
    jobs: { name: (id: string) => `evaluation-${id}`, get: getJob, start: vi.fn() },
    freeze: async () => snapshot,
    prepare: vi.fn(),
    validate: vi.fn(),
    publish,
    ready,
  } as unknown as EvaluationDependencies;
  const client = createClient(
    EvaluationService,
    createRouterTransport((router) =>
      router.service(EvaluationService, evaluationService(dependencies)),
    ),
  );
  const report = () => {
    record.report = create(EvaluationReportSchema, {
      bindingDigest: record.candidate.bindingDigest,
      completedAt: timestampFromMs(Date.now()),
      feedbackSynchronized: true,
      samples: [
        {
          sampleId: "holdout",
          repetition: 1,
          candidate: [{ name: "correctness", value: 1 }],
          released: [{ name: "correctness", value: 1 }],
          candidateTraceId: "candidate-trace",
          releasedTraceId: "released-trace",
          candidateTaskId: "candidate-task",
          releasedTaskId: "released-task",
        },
      ],
    });
    return record.report;
  };
  return { client, snapshot, report, publish, ready, getJob, record: () => record };
}

it("requires a complete report and acknowledged feedback after native Job success", async () => {
  const f = fixture(),
    id = f.record().candidate.id;
  await f.client.runEvaluation({ id });
  expect((await f.client.getCandidate({ id })).candidate?.state).toBe(CandidateState.FAILED);
  await expect(
    f.client.publishCandidate({ id, bindingDigest: f.record().candidate.bindingDigest }),
  ).rejects.toThrow(/current passing/);
  const report = f.report();
  report.feedbackSynchronized = false;
  expect((await f.client.getCandidate({ id })).candidate?.failures).toContain(
    "evaluation.feedbackPending",
  );
  report.feedbackSynchronized = true;
  expect((await f.client.getCandidate({ id })).candidate?.state).toBe(CandidateState.PASSED);
  expect(f.publish).not.toHaveBeenCalled();
});

it("invalidates a successful report when a frozen input changes before publication", async () => {
  const f = fixture(),
    id = f.record().candidate.id;
  await f.client.runEvaluation({ id });
  f.report();
  f.snapshot.knowledgeDigest = "different knowledge";
  expect((await f.client.getCandidate({ id })).candidate?.state).toBe(CandidateState.STALE);
  await expect(
    f.client.publishCandidate({ id, bindingDigest: f.record().candidate.bindingDigest }),
  ).rejects.toThrow(/current passing/);
  expect(f.publish).not.toHaveBeenCalled();
});

it("keeps publication recoverable until native revisions are ready and is idempotent after publication", async () => {
  const f = fixture(),
    id = f.record().candidate.id;
  await f.client.runEvaluation({ id });
  f.report();
  f.ready.mockResolvedValue(false);
  const request = { id, bindingDigest: f.record().candidate.bindingDigest };
  expect((await f.client.publishCandidate(request)).candidate?.state).toBe(
    CandidateState.PUBLISHING,
  );
  f.ready.mockResolvedValue(true);
  expect((await f.client.publishCandidate(request)).candidate?.state).toBe(
    CandidateState.PUBLISHED,
  );
  const attempts = f.publish.mock.calls.length;
  await f.client.publishCandidate(request);
  expect(f.publish).toHaveBeenCalledTimes(attempts);
});

it("fails closed when the native Job disappears instead of trusting a retained passing report", async () => {
  const f = fixture(),
    id = f.record().candidate.id;
  await f.client.runEvaluation({ id });
  f.report();
  f.getJob.mockResolvedValue(undefined as never);
  expect((await f.client.getCandidate({ id })).candidate?.failures).toContain(
    "evaluation.jobMissing",
  );
  await expect(
    f.client.publishCandidate({ id, bindingDigest: f.record().candidate.bindingDigest }),
  ).rejects.toThrow(/current passing/);
  expect(f.publish).not.toHaveBeenCalled();
});
