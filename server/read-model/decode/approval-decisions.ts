import { fromJson, toJson } from "@bufbuild/protobuf";
import type { Message } from "../../../gen/a2a_pb.js";
import { type Approval, ApprovalSchema } from "../../../gen/agentos/governance/v1/governance_pb.js";

const key = "agentos.dev/approval-decisions";

/** Persist the decision service's typed outcome alongside the native boolean reply. */
export function withApprovalDecisions(message: Message, decisions: Approval[]): Message {
  message.metadata = {
    ...message.metadata,
    [key]: decisions.map((decision) => toJson(ApprovalSchema, decision)),
  };
  return message;
}

export function approvalDecisions(message?: Message): Approval[] {
  const records = message?.metadata?.[key];
  if (!Array.isArray(records)) return [];
  return records.flatMap((record) => {
    try {
      const approval = fromJson(ApprovalSchema, record);
      return approval.reference?.taskId === message?.taskId ? [approval] : [];
    } catch {
      return [];
    }
  });
}
