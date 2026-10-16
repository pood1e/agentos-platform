import { type JsonValue, toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ChangeBlocker,
  type ChangeRequest,
  ChangeRequestSchema,
} from "../../../../gen/agentos/governance/v1/change_pb.js";
import { redact } from "../../../../shared/redact.js";
import { digest } from "../../../shared/change-digest.js";
import { changeProposal } from "../../../shared/change-proposal.js";
import { shortTitle } from "../../../shared/title.js";
import messages from "../../messages.json" with { type: "json" };
import type { ApprovalDecision, ApprovalProvider } from "../../provider.js";
import type { Ticket, Zammad } from "./api.js";

const copyFor = (intent: string) => messages[/\p{Script=Han}/u.test(intent) ? "zh" : "en"];
const attachment = (filename: string, value: string) => ({
  filename,
  data: Buffer.from(value).toString("base64"),
  "mime-type": "application/json",
});

function failureReason(output: JsonValue): string {
  if (typeof output === "string") return output.split("\n")[0]?.slice(0, 180) ?? "";
  if (!output || Array.isArray(output) || typeof output !== "object") return "";
  const summary = output.summary;
  const error =
    output.error ??
    output.message ??
    (summary && typeof summary === "object" && !Array.isArray(summary) ? summary.error : null);
  return error ? failureReason(error) : "";
}

const planFields = new Set([
  "agentos_change_key",
  "agentos_plan_hash",
  "agentos_proposal",
  "agentos_change_type",
  "agentos_impact",
  "agentos_validation",
  "agentos_rollback",
  "agentos_simulation",
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
    request = changeProposal(request);
    const summary = request.intent.trim() || request.preparation?.plan?.impact.trim() || "";
    const copy = copyFor(summary || request.prompt);
    const proposal = JSON.stringify(toJson(ChangeRequestSchema, request));
    const ticket = await this.api.create({
      title: shortTitle(summary) || copy.fallbackTitle,
      group: "AgentOS Changes",
      customer: "agentos-coordinator@local.domain",
      agentos_change_key: id,
      agentos_plan_hash: hash,
      agentos_proposal: proposal,
      agentos_change_type: "normal",
      agentos_impact: request.preparation?.plan?.impact,
      agentos_validation: request.preparation?.plan?.validation,
      agentos_rollback: request.preparation?.plan?.rollback,
      agentos_simulation: request.preparation?.simulationReport,
      agentos_decision: "pending",
      agentos_reason: "",
      article: {
        subject: copy.proposal,
        type: "note",
        internal: true,
        content_type: "text/plain",
        body: summary || copy.fallbackTitle,
        attachments: [attachment("change-proposal.json", proposal)],
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
    const waiting = {
      approved: false,
      rejected: false,
      canceled: false,
      reason: "",
      actor: "",
      version: "",
      blocker: ChangeBlocker.UNSPECIFIED,
    };
    const closed = ["closed", "removed"].includes(ticket.state);
    if (
      !record ||
      !["approved", "rejected"].includes(ticket.agentos_decision) ||
      record.value_to !== ticket.agentos_decision
    )
      return { ...waiting, canceled: closed };
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
    if (closed)
      return {
        ...waiting,
        rejected: ticket.agentos_decision === "rejected",
        canceled: ticket.agentos_decision !== "rejected",
        actor: actor.login,
        reason: ticket.agentos_reason ?? "",
      };
    if (
      history.history.some(
        (entry) =>
          entry.id > record.id &&
          entry.created_at !== record.created_at &&
          entry.value_from !== entry.value_to &&
          planFields.has(entry.attribute),
      )
    )
      return {
        ...waiting,
        blocker: ChangeBlocker.PLAN_CHANGED,
      };
    if (ticket.agentos_change_type !== "normal")
      return { ...waiting, blocker: ChangeBlocker.NORMAL_CHANGE_REQUIRED };
    if (
      ticket.agentos_decision === "approved" &&
      ![ticket.agentos_impact, ticket.agentos_validation, ticket.agentos_rollback].every((value) =>
        value?.trim(),
      )
    )
      return { ...waiting, blocker: ChangeBlocker.ASSESSMENT_REQUIRED };
    return {
      approved:
        ticket.agentos_decision === "approved" && !["closed", "removed"].includes(ticket.state),
      rejected: ticket.agentos_decision === "rejected",
      canceled: false,
      reason: ticket.agentos_reason ?? "",
      blocker: ChangeBlocker.UNSPECIFIED,
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
      simulation: ticket.agentos_simulation,
    };
  }

  async result(
    ticketId: string,
    failed: boolean,
    output: JsonValue,
    intent: string,
    changeId: string,
  ) {
    const copy = copyFor(intent),
      subject = copy.result;
    const visible = redact(output),
      reason = failureReason(visible);
    const notes = await this.api.articles(ticketId);
    const messageId = `<aiops-execution-${changeId}@agentos.local>`;
    if (!notes.some((note) => note.message_id === messageId))
      await this.api.request("ticket_articles", "POST", {
        ticket_id: Number(ticketId),
        subject,
        message_id: messageId,
        type: "note",
        internal: true,
        content_type: "text/plain",
        body: `${failed ? `${copy.failed}${reason ? `: ${reason}` : "."}` : copy.succeeded}\n${copy.details}`,
        attachments: [attachment("execution-result.json", JSON.stringify(visible, null, 2))],
      });
    await this.api.update(ticketId, { state: "open" });
  }
}
