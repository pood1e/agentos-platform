import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  ConfigurationSnapshotSchema,
  EvaluationReportSchema,
} from "../gen/agentos/evaluation/v1/evaluation_pb.js";
import { evaluationFailures, snapshotDigest } from "../server/evaluation/gate.js";
import { ruleSummaries } from "../shared/evaluation.js";

function fixture() {
  const snapshot = create(ConfigurationSnapshotSchema, {
    workspace: "workspace",
    platformImage: "platform@sha256:fixed",
    packImage: "solution@sha256:fixed",
    knowledgeDigest: "knowledge",
    credentialsDigest: "credentials",
    baseline: {
      name: "ops",
      version: "v1",
      repetitions: 2,
      samples: [
        { id: "training", split: "train" },
        { id: "unseen", split: "holdout" },
      ],
      rules: [{ name: "correctness", minimum: 0.8, maximumRegression: 0 }],
    },
  });
  const report = create(EvaluationReportSchema, {
    bindingDigest: snapshotDigest(snapshot),
    feedbackSynchronized: true,
    completedAt: timestampFromMs(Date.now()),
    samples: ["training", "unseen"].flatMap((sampleId) =>
      [1, 2].map((repetition) => ({
        sampleId,
        repetition,
        candidateTraceId: "candidate-trace",
        releasedTraceId: "released-trace",
        candidateTaskId: "candidate-task",
        releasedTaskId: "released-task",
        candidate: [{ name: "correctness", value: 1 }],
        released: [{ name: "correctness", value: 1 }],
      })),
    ),
  });
  return { snapshot, report };
}

describe("evaluation publication gate", () => {
  it("reports means without hiding per-case threshold failures and regressions", () => {
    const { snapshot, report } = fixture();
    const baseline = snapshot.baseline;
    const candidate = report.samples[0]?.candidate[0];
    if (!baseline || !candidate) throw new Error("missing fixture");
    candidate.value = 0.7;
    const summary = ruleSummaries(baseline, report)[0];
    expect(summary?.candidate).toBeCloseTo(0.925);
    expect(summary?.released).toBe(1);
    expect(summary?.delta).toBeCloseTo(-0.075);
    expect(summary?.failures).toEqual(
      expect.arrayContaining(["evaluation.belowThreshold", "evaluation.regression"]),
    );
    expect(evaluationFailures(snapshot, report)).toEqual(
      expect.arrayContaining(summary?.failures ?? []),
    );
  });

  it("does not pass rule summaries with missing, duplicate, erroneous or invalid results", () => {
    for (const failure of ["missing", "duplicate", "error", "invalid", "score"]) {
      const { snapshot, report } = fixture();
      if (!snapshot.baseline || !report.samples[0]) throw new Error("missing fixture");
      if (failure === "missing") report.samples.pop();
      if (failure === "duplicate") report.samples[3] = report.samples[0];
      if (failure === "error") report.samples[0].error = "evaluation.executionFailed";
      if (failure === "invalid") report.samples[0].candidate[0].value = Number.NaN;
      if (failure === "score") report.samples[0].candidate = [];
      expect(ruleSummaries(snapshot.baseline, report)[0]?.failures.length).toBeGreaterThan(0);
    }
    const { snapshot, report } = fixture();
    if (!snapshot.baseline) throw new Error("missing baseline");
    expect(ruleSummaries(snapshot.baseline, report)[0]).toMatchObject({
      candidate: 1,
      released: 1,
      delta: 0,
      failures: [],
    });
  });
  it("requires every held-out sample and repetition for both configurations", () => {
    const { snapshot, report } = fixture();
    expect(evaluationFailures(snapshot, report)).toEqual([]);
    report.samples.pop();
    expect(evaluationFailures(snapshot, report)).toContain("evaluation.sampleMissing");
  });
  it("invalidates a report when any frozen runtime, baseline or data binding changes", () => {
    const { snapshot, report } = fixture();
    snapshot.knowledgeDigest = "changed";
    expect(evaluationFailures(snapshot, report)).toContain("evaluation.bindingChanged");
  });
  it("blocks regression, thresholds, duplicate or missing scores and uncompleted results", () => {
    const { snapshot, report } = fixture();
    const score = report.samples[0]?.candidate[0];
    if (!score) throw new Error("Missing fixture");
    score.value = 0.7;
    expect(evaluationFailures(snapshot, report)).toEqual(
      expect.arrayContaining(["evaluation.belowThreshold", "evaluation.regression"]),
    );
    report.samples[0]?.candidate.push({ ...score });
    expect(evaluationFailures(snapshot, report)).toContain("evaluation.scoreMissing");
    report.completedAt = undefined;
    expect(evaluationFailures(snapshot, report)).toContain("evaluation.incomplete");
    expect(evaluationFailures(snapshot)).toEqual(["evaluation.reportMissing"]);
  });
  it("does not accept a duplicate result in place of another sample", () => {
    const { snapshot, report } = fixture();
    report.samples[3] = report.samples[0] ?? report.samples[3];
    expect(evaluationFailures(snapshot, report)).toContain("evaluation.sampleMismatch");
  });
});
