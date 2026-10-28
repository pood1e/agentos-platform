import { create } from "@bufbuild/protobuf";
import type { ExecutionSource } from "../../gen/agentos/authorization/v1/workload_pb.js";
import { ExecutionIdentitySchema } from "../../gen/agentos/execution/v1/identity_pb.js";
import { messageIdentity } from "../shared/idempotency.js";

export function executionPrincipal(source: ExecutionSource) {
  return create(ExecutionIdentitySchema, {
    subject: `service:execution:${messageIdentity(source.issuer, source.audience, source.clientId, source.subject)}`,
    write: source.write,
    capabilities: source.capabilities,
    credential: { case: "service", value: true },
  });
}
