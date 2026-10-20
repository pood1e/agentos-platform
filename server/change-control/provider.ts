import type { JsonValue } from "@bufbuild/protobuf";
import type { ChangeBlocker, ChangeRequest } from "../../gen/agentos/governance/v1/change_pb.js";

export interface ApprovalDecision {
  approved: boolean;
  rejected: boolean;
  canceled: boolean;
  blocker: ChangeBlocker;
  reason: string;
  actor: string;
  /** Changes whenever the decision or the approved assessment changes. */
  version: string;
}

/** The approval system owns decisions; change control keeps only correlation and execution state. */
export interface ApprovalProvider {
  /** Creates the approval ticket for a registered change, reusing an existing one for the same id. */
  create(id: string, hash: string, request: ChangeRequest): Promise<string>;
  decision(ticketId: string, id: string, hash: string): Promise<ApprovalDecision>;
  result(
    ticketId: string,
    failed: boolean,
    output: JsonValue,
    intent: string,
    changeId: string,
  ): Promise<void>;
  url(ticketId: string): string;
}
