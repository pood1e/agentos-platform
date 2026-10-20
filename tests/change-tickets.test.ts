import { randomUUID } from "node:crypto";
import { create, toJson } from "@bufbuild/protobuf";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangeRequestSchema } from "../gen/agentos/governance/v1/change_pb.js";
import { Zammad } from "../server/change-control/providers/zammad/api.js";
import { ZammadApprovals } from "../server/change-control/providers/zammad/approvals.js";
import { digest } from "../server/shared/change-digest.js";
import { changeProposal } from "../server/shared/change-proposal.js";
import { fakeZammad } from "./fake-zammad.js";

let server: Awaited<ReturnType<typeof fakeZammad>>;
beforeEach(async () => {
  server = await fakeZammad();
});
afterEach(async () => {
  await server.close();
});

it.each(["", " \n\t"])(
  "registers a native pause without an intent using its prepared assessment (%j)",
  async (intent) => {
    const api = new Zammad(server.url, "coordinator");
    const submit = vi.spyOn(api, "create");
    const impact = "仅在指定设备执行一次短测，保持空闲检查与超时约束。";
    const request = create(ChangeRequestSchema, {
      engineer: "delivery",
      taskId: randomUUID(),
      contextId: randomUUID(),
      requestId: "approval",
      intent,
      preparation: {
        operationHash: "operation",
        plan: {
          impact,
          validation: "读取执行结果",
          rollback: "清理本次进程",
        },
      },
    });
    const proposal = toJson(ChangeRequestSchema, changeProposal(request));
    const hash = digest(proposal);
    const id = await new ZammadApprovals(api, 7, server.url).create(randomUUID(), hash, request);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(/指定设备/u),
        agentos_decision: "pending",
        article: expect.objectContaining({ subject: "变更申请", body: impact }),
      }),
    );
    const ticket = await api.ticket(id);
    expect(JSON.parse(ticket.agentos_proposal)).toEqual(proposal);
    expect(ticket.agentos_plan_hash).toBe(hash);
    expect(digest(JSON.parse(ticket.agentos_proposal))).toBe(hash);
  },
);
