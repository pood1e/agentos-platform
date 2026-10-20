import type { Approval } from "../../../gen/agentos/governance/v1/governance_pb.js";

export const approvalIdentity = (approval: Approval) =>
  approval.id ? JSON.stringify([approval.link?.url ?? "", approval.id]) : undefined;
