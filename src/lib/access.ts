import { useQuery } from "@tanstack/react-query";
import type { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { errorKey, unreachable } from "../../shared/errors.js";
import { can } from "../../shared/permissions.js";
import { connection } from "./connection.js";
import { consoleClient } from "./console.js";

export function useAccess({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["access-profile"],
    queryFn: async ({ signal }) => {
      try {
        const { profile } = await consoleClient.getAccessProfile({}, { signal, timeoutMs: 5000 });
        connection.succeeded();
        return profile;
      } catch (error) {
        if (unreachable(error)) connection.failed(errorKey(error, "connection.reconnecting"));
        else connection.succeeded();
        throw error;
      }
    },
    staleTime: 60_000,
    refetchInterval: poll ? (query) => (query.state.status === "error" ? 1000 : 10_000) : false,
    retry: false,
    networkMode: "always",
  });
}

export function useCapability(capability: Capability) {
  return can(useAccess().data, capability);
}
