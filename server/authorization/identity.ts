import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { UserIdentitySchema } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { roleCapabilities } from "../../shared/permissions.js";
import type { KagentClients } from "../kagent/clients.js";
import { credentialHeaders } from "../kagent/context.js";

/** kagent verifies the token and owns canonical principal IDs. */
export function userIdentity(clients: KagentClients, writerRole: string) {
  return async (headers: Headers) => {
    const result = await clients.system.getCurrentUser(
      {},
      { headers: credentialHeaders(headers), timeoutMs: 10_000 },
    );
    if (!result.principalId)
      throw new ConnectError("Authenticated principal required", Code.Unauthenticated);
    const roles = result.claims?.roles;
    return create(UserIdentitySchema, {
      subject: result.principalId,
      write: Array.isArray(roles) && roles.includes(writerRole),
      capabilities: roleCapabilities(roles),
    });
  };
}
