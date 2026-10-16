import { useQuery } from "@tanstack/react-query";
import { consoleClient } from "./console.js";

export function useAccess() {
  return useQuery({
    queryKey: ["access-profile"],
    queryFn: async () => (await consoleClient.getAccessProfile({})).profile,
    staleTime: 60_000,
  });
}
