import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { ChangeRequestSchema } from "../gen/agentos/governance/v1/change_pb.js";
import { Zammad } from "../server/change-control/providers/zammad/api.js";
import { ZammadApprovals } from "../server/change-control/providers/zammad/approvals.js";
import { fakeZammad } from "./fake-zammad.js";

it("keeps the summary short and attaches the complete redacted proposal", async () => {
  const api = await fakeZammad();
  try {
    const tickets = new ZammadApprovals(new Zammad(api.url, "coordinator"), 7, api.url);
    const request = create(ChangeRequestSchema, {
      intent: "采集两台设备信息，保留现有账号和密码",
      tool: { name: "real-jumpserver_ops_jobs_create", args: { password: "private-value" } },
      preparation: {
        plan: { impact: "仅只读采集", validation: "读取执行结果", rollback: "超时停止" },
        simulationReport: "完整验证证据".repeat(200),
      },
    });
    const id = await tickets.create("change", "hash", request);
    const ticket = api.records.get(Number(id));
    assert(ticket);
    expect(ticket.title).toBe("采集两台设备信息");
    const article = (
      ticket as unknown as {
        article: { subject: string; body: string; attachments: { data: string }[] };
      }
    ).article;
    expect(article.body).toBe(request.intent);
    const proposal = Buffer.from(article.attachments[0]?.data ?? "", "base64").toString();
    expect(JSON.parse(proposal).preparation.simulationReport).toBe(
      request.preparation?.simulationReport,
    );
    expect(proposal).not.toContain("private-value");
    expect(proposal).toContain("[REDACTED]");
  } finally {
    await api.close();
  }
});

it.each([
  ["执行设备命令", "执行结果"],
  ["Run device command", "Execution result"],
])("keeps %s outcomes concise, complete and idempotent", async (intent, subject) => {
  const api = await fakeZammad();
  try {
    const tickets = new ZammadApprovals(new Zammad(api.url, "coordinator"), 7, api.url);
    const id = await tickets.create("change", "hash", create(ChangeRequestSchema, { intent }));
    const output = {
      error: "Executor unavailable",
      password: "private-value",
      observations: "evidence".repeat(10000),
    };
    await tickets.result(id, true, output, intent, "change");
    await tickets.result(id, true, output, intent, "change");
    expect(api.uploaded).toHaveLength(1);
    const note = api.uploaded[0];
    expect(note?.subject).toBe(subject);
    expect(note?.body).toContain("Executor unavailable");
    expect(note?.body.length).toBeLessThan(160);
    const recorded = Buffer.from(note?.attachments?.[0]?.data ?? "", "base64").toString();
    expect(JSON.parse(recorded).observations).toBe(output.observations);
    expect(recorded).not.toContain("private-value");
    expect(recorded).toContain("[REDACTED]");
  } finally {
    await api.close();
  }
});
