import { createHash } from "node:crypto";
import { toJson } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import canonicalize from "canonicalize";
import {
  type ConfigurationSnapshot,
  ConfigurationSnapshotSchema,
  type EvaluationReport,
} from "../../gen/agentos/evaluation/v1/evaluation_pb.js";

export function snapshotDigest(snapshot: ConfigurationSnapshot): string {
  return createHash("sha256")
    .update(canonicalize(toJson(ConfigurationSnapshotSchema, snapshot)) ?? "")
    .digest("hex");
}

/** Every frozen sample, repetition and score must be present on both configurations. */
export function evaluationFailures(
  snapshot: ConfigurationSnapshot,
  report?: EvaluationReport,
): string[] {
  if (!report) return ["evaluation.reportMissing"];
  const baseline = snapshot.baseline;
  if (!baseline?.samples.length || !baseline.rules.length) return ["evaluation.baselineMissing"];
  const failures = new Set<string>();
  if (!report.feedbackSynchronized) failures.add("evaluation.feedbackPending");
  if (report.bindingDigest !== snapshotDigest(snapshot)) failures.add("evaluation.bindingChanged");
  if (report.error) failures.add(report.error);
  if (!report.completedAt || timestampMs(report.completedAt) > Date.now() + 30_000)
    failures.add("evaluation.incomplete");
  if (!baseline.samples.some((sample) => sample.split === "holdout"))
    failures.add("evaluation.holdoutMissing");
  const expected = new Set(
    baseline.samples.flatMap((sample) =>
      Array.from({ length: baseline.repetitions }, (_, index) => `${sample.id}:${index + 1}`),
    ),
  );
  const observed = new Set<string>();
  for (const sample of report.samples) {
    const key = `${sample.sampleId}:${sample.repetition}`;
    if (!expected.has(key) || observed.has(key)) failures.add("evaluation.sampleMismatch");
    observed.add(key);
    if (
      sample.error ||
      !sample.candidateTraceId ||
      !sample.releasedTraceId ||
      !sample.candidateTaskId ||
      !sample.releasedTaskId
    )
      failures.add("evaluation.incomplete");
    for (const scores of [sample.candidate, sample.released]) {
      const names = scores.map((score) => score.name);
      if (
        names.length !== baseline.rules.length ||
        new Set(names).size !== names.length ||
        names.some((name) => !baseline.rules.some((rule) => rule.name === name))
      )
        failures.add("evaluation.scoreMissing");
      if (scores.some((score) => !Number.isFinite(score.value)))
        failures.add("evaluation.invalidScore");
    }
    for (const rule of baseline.rules) {
      const candidate = sample.candidate.find((score) => score.name === rule.name);
      const released = sample.released.find((score) => score.name === rule.name);
      if (!candidate || !released) {
        failures.add("evaluation.scoreMissing");
        continue;
      }
      if (candidate.value < rule.minimum) failures.add("evaluation.belowThreshold");
      if (released.value - candidate.value > rule.maximumRegression)
        failures.add("evaluation.regression");
    }
  }
  if (expected.size !== observed.size || [...expected].some((key) => !observed.has(key)))
    failures.add("evaluation.sampleMissing");
  return [...failures];
}
