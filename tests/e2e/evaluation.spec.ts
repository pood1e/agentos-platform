import { expect, test } from "@playwright/test";
import { resetKagent } from "./kagent.js";

test("shows per-rule means and failures, sample errors and native Langfuse trace links", async ({
  page,
  request,
}) => {
  await resetKagent(request);
  const id = "8305aa3c-c01c-4882-8d30-3c72ce98f024";
  const candidate = {
    id,
    name: "UpdateRole:inspection",
    state: "CANDIDATE_STATE_FAILED",
    baseline: "ops",
    baselineVersion: "1",
    report: {
      experimentUrl: "https://traces.example.test/project/team/experiments/run",
      samples: [
        {
          sampleId: "first",
          repetition: 1,
          candidate: [{ name: "correctness", value: 0.7 }],
          released: [{ name: "correctness", value: 0.9 }],
          candidateTraceUrl: "https://traces.example.test/project/team/traces/candidate",
          releasedTraceUrl: "https://traces.example.test/project/team/traces/released",
        },
        {
          sampleId: "second",
          repetition: 1,
          candidate: [{ name: "correctness", value: 1 }],
          released: [{ name: "correctness", value: 0.9 }],
          error: "evaluation.executionFailed",
        },
      ],
    },
  };
  await page.route("**/agentos.evaluation.v1.EvaluationService/ListCandidates", (route) =>
    route.fulfill({ json: { candidates: [candidate] } }),
  );
  await page.route("**/agentos.evaluation.v1.EvaluationService/GetCandidate", (route) =>
    route.fulfill({
      json: {
        candidate,
        snapshot: {
          baseline: {
            repetitions: 1,
            samples: [
              { id: "first", name: "正常用例" },
              { id: "second", name: "失败用例" },
            ],
            rules: [{ name: "correctness", minimum: 0.8, maximumRegression: 0.1 }],
          },
        },
      },
    }),
  );
  await page.goto(`/engineers/evaluation?candidate=${id}`);
  await page.getByRole("tab", { name: "测评结果", exact: true }).click();
  const summary = page.getByRole("region", { name: "规则汇总", exact: true });
  await expect(summary).toContainText("0.85");
  await expect(summary).toContainText("0.90");
  await expect(summary).toContainText("-0.05");
  await expect(summary).toContainText("评分未达到门槛。");
  await expect(summary).toContainText("评分退化超出允许范围。");
  await expect(page.getByRole("cell", { name: "原生执行或评分失败。", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "候选追踪", exact: true })).toHaveAttribute(
    "href",
    "https://traces.example.test/project/team/traces/candidate",
  );
  await expect(page.getByRole("link", { name: "已发布追踪", exact: true })).toHaveAttribute(
    "href",
    "https://traces.example.test/project/team/traces/released",
  );
});
