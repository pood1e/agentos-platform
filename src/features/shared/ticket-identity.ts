import type { Change } from "../../../gen/agentos/governance/v1/change_pb.js";

export const ticketIdentity = (change: Change) =>
  change.environment?.name && change.ticketId
    ? JSON.stringify([change.environment.name, change.ticketId])
    : undefined;
