import { toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type ChangeRequest,
  ChangeRequestSchema,
} from "../../../../gen/agentos/governance/v1/change_pb.js";
import { digest } from "../../../shared/change-digest.js";
import type { ApprovalDecision, ApprovalProvider } from "../../provider.js";
import type { Ticket, Zammad } from "./api.js";

const planFields = new Set([
  "agentos_change_key",
  "agentos_plan_hash",
  "agentos_proposal",
  "agentos_change_type",
  "agentos_impact",
  "agentos_validation",
  "agentos_rollback",
]);

/** Native Zammad roles and ticket history own change decisions. */
export class ZammadApprovals implements ApprovalProvider {
  constructor(
    private api: Zammad,
    private approverRole: number,
    private portalUrl: string,
  ) {}

  url(ticketId: string) {
    return `${this.portalUrl}/#ticket/zoom/${ticketId}`;
  }

  async create(id: string, hash: string, request: ChangeRequest) {
    const existing = await this.api.find(id);
    if (existing) return String(existing.id);
    const proposal = JSON.stringify(toJson(ChangeRequestSchema, request));
    const ticket = await this.api.create({
      title: `变更 · ${request.engineer} · ${request.tool?.name}`.slice(0, 180),
      group: "AgentOS Changes",
      customer: "agentos-coordinator@local.domain",
      agentos_change_key: id,
      agentos_plan_hash: hash,
      agentos_proposal: proposal,
      agentos_change_type: "normal",
      agentos_decision: "pending",
      agentos_reason: "",
      article: {
        subject: "变更方案与观测证据",
        type: "note",
        internal: true,
        content_type: "text/plain",
        body: `${request.intent}\n\n${JSON.stringify(toJson(ChangeRequestSchema, request), null, 2)}`,
      },
    });
    return String(ticket.id);
  }

  async decision(ticketId: string, id: string, hash: string): Promise<ApprovalDecision> {
    const [ticket, history] = await Promise.all([
      this.api.ticket(ticketId),
      this.api.history(ticketId),
    ]);
    if (ticket.agentos_change_key !== id || ticket.agentos_plan_hash !== hash)
      throw new ConnectError("Ticket plan differs from registered change", Code.FailedPrecondition);
    if (!ticket.agentos_proposal || digest(JSON.parse(ticket.agentos_proposal)) !== hash)
      throw new ConnectError(
        "Approved proposal differs from the registered operation",
        Code.FailedPrecondition,
      );
    const record = history.history
      .filter((item) => item.attribute === "agentos_decision")
      .sort((a, b) => b.id - a.id)[0];
    const waiting = { approved: false, rejected: false, reason: "", actor: "", version: "" };
    if (
      !record ||
      !["approved", "rejected"].includes(ticket.agentos_decision) ||
      record.value_to !== ticket.agentos_decision
    )
      return waiting;
    const actor = await this.api.user(record.created_by_id);
    if (
      !actor.active ||
      !actor.role_ids.includes(this.approverRole) ||
      actor.id === ticket.created_by_id
    )
      throw new ConnectError(
        "Ticket decision was made by an unauthorized identity",
        Code.PermissionDenied,
      );
    if (!ticket.agentos_reason?.trim())
      return { ...waiting, reason: "An approval reason is required" };
    if (history.history.some((entry) => entry.id > record.id && planFields.has(entry.attribute)))
      return {
        ...waiting,
        reason: "The change plan was modified after approval; a fresh approval is required",
      };
    if (ticket.agentos_change_type !== "normal")
      return { ...waiting, reason: "This execution path requires the Normal Change process" };
    if (
      ticket.agentos_decision === "approved" &&
      ![ticket.agentos_impact, ticket.agentos_validation, ticket.agentos_rollback].every((value) =>
        value?.trim(),
      )
    )
      return { ...waiting, reason: "Impact analysis, validation and rollback plans are required" };
    return {
      approved:
        ticket.agentos_decision === "approved" && !["closed", "removed"].includes(ticket.state),
      rejected:
        ticket.agentos_decision === "rejected" || ["closed", "removed"].includes(ticket.state),
      reason: ticket.agentos_reason,
      actor: actor.login,
      version: digest({
        audit: { ...record },
        assessment: this.assessment(ticket),
        reason: ticket.agentos_reason,
      }),
    };
  }

  private assessment(ticket: Ticket) {
    return {
      proposal: ticket.agentos_proposal,
      type: ticket.agentos_change_type,
      impact: ticket.agentos_impact,
      validation: ticket.agentos_validation,
      rollback: ticket.agentos_rollback,
    };
  }

  async result(ticketId: string, failed: boolean, output: unknown, executed: boolean) {
    const subject = `AgentOS execution result: ${ticketId}`;
    const notes = await this.api.articles(ticketId);
    if (!notes.some((note) => note.subject === subject))
      await this.api.request("ticket_articles", "POST", {
        ticket_id: Number(ticketId),
        subject,
        type: "note",
        internal: true,
        content_type: "text/plain",
        body: `${failed ? "Failed" : "Succeeded"}\n\n${JSON.stringify(output, null, 2).slice(0, 64 * 1024)}`,
      });
    await this.api.update(ticketId, { state: executed ? "open" : "closed" });
  }
}
