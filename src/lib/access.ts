import { useQuery } from "@tanstack/react-query";
import type { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { can } from "../../shared/permissions.js";
import { consoleClient } from "./console.js";

export function useAccess() {
  return useQuery({
    queryKey: ["access-profile"],
    queryFn: async () => (await consoleClient.getAccessProfile({})).profile,
    staleTime: 60_000,
  });
}

export function useCapability(capability: Capability) {
  return can(useAccess().data, capability);
}
