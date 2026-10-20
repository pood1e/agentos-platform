import { Code, ConnectError } from "@connectrpc/connect";
import { type ClientCheckRequest, ConsistencyPreference, type OpenFgaClient } from "@openfga/sdk";

export type Permission = Pick<ClientCheckRequest, "user" | "relation" | "object">;

/** Requires every permission against one immutable model and server-supplied time. */
export function authorizer(client: OpenFgaClient, authorizationModelId: string) {
  if (!authorizationModelId) throw new Error("Authorization model ID is required");
  return async (permissions: readonly Permission[]): Promise<void> => {
    if (!permissions.length)
      throw new ConnectError("Permission is required", Code.PermissionDenied);
    const context = { current_time: new Date().toISOString() };
    const checks = permissions.map(({ user, relation, object }, index) => ({
      user,
      relation,
      object,
      context,
      correlationId: String(index),
    }));
    const response = await client
      .batchCheck(
        { checks },
        {
          authorizationModelId,
          consistency: ConsistencyPreference.HigherConsistency,
        },
      )
      .catch(() => {
        throw new ConnectError("Authorization service is unavailable", Code.Unavailable);
      });
    const expected = new Set(checks.map((check) => check.correlationId));
    const permitted =
      response.result.length === checks.length &&
      response.result.every((decision) => {
        if (!expected.delete(decision.correlationId)) return false;
        return decision.allowed === true && !decision.error;
      });
    if (!permitted) throw new ConnectError("Permission denied", Code.PermissionDenied);
  };
}
