import type {
  EvaluationBaseline,
  EvaluationReport,
  SampleResult,
  Score,
  ScoreRule,
} from "../gen/agentos/evaluation/v1/evaluation_pb.js";

function scoreValue(scores: Score[], name: string): number | undefined {
  const matching = scores.filter((score) => score.name === name);
  return matching.length === 1 && Number.isFinite(matching[0]?.value)
    ? matching[0]?.value
    : undefined;
}

export function scoreRuleFailures(rule: ScoreRule, sample: SampleResult): string[] {
  const candidate = scoreValue(sample.candidate, rule.name);
  const released = scoreValue(sample.released, rule.name);
  if (candidate === undefined || released === undefined) return ["evaluation.scoreMissing"];
  return [
    ...(candidate < rule.minimum ? ["evaluation.belowThreshold"] : []),
    ...(released - candidate > rule.maximumRegression ? ["evaluation.regression"] : []),
  ];
}

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

/** Means describe the run; verdicts retain every per-case threshold and regression failure. */
export function ruleSummaries(baseline: EvaluationBaseline, report: EvaluationReport) {
  const expected = new Set(
    baseline.samples.flatMap((sample) =>
      Array.from({ length: baseline.repetitions }, (_, i) => `${sample.id}:${i + 1}`),
    ),
  );
  const rows = report.samples.filter((sample) =>
    expected.has(`${sample.sampleId}:${sample.repetition}`),
  );
  const observed = new Set(rows.map((sample) => `${sample.sampleId}:${sample.repetition}`));
  const incomplete =
    !expected.size ||
    observed.size !== expected.size ||
    report.samples.length !== expected.size ||
    rows.some((row) => !!row.error);
  return baseline.rules.map((rule) => {
    const candidate = mean(rows.flatMap((row) => scoreValue(row.candidate, rule.name) ?? []));
    const released = mean(rows.flatMap((row) => scoreValue(row.released, rule.name) ?? []));
    return {
      rule,
      candidate,
      released,
      delta: candidate !== undefined && released !== undefined ? candidate - released : undefined,
      failures: [
        ...new Set([
          ...(incomplete ? ["evaluation.incomplete"] : []),
          ...rows.flatMap((row) => scoreRuleFailures(rule, row)),
        ]),
      ],
    };
  });
}
