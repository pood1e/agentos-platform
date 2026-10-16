import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  ConfigurationSnapshotSchema,
  EvaluationReportSchema,
} from "../gen/agentos/evaluation/v1/evaluation_pb.js";
import { evaluationFailures, snapshotDigest } from "../server/evaluation/gate.js";

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
        candidate: [{ name: "correctness", value: 1 }],
        released: [{ name: "correctness", value: 1 }],
      })),
    ),
  });
  return { snapshot, report };
}

describe("evaluation publication gate", () => {
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
