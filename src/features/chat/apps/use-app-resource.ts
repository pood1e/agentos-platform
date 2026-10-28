import { Code, ConnectError } from "@connectrpc/connect";
import { useQuery } from "@tanstack/react-query";
import type { AppReference } from "../../../../gen/agentos/mcp/v1/app_pb.js";
import { consoleClient } from "../../../lib/console.js";

export function useAppResource(reference: AppReference) {
  return useQuery({
    queryKey: ["app-resource", reference.taskId, reference.callId],
    queryFn: ({ signal }) =>
      consoleClient.getAppResource({ app: reference }, { signal, timeoutMs: 20_000 }),
    staleTime: 60_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (attempt, error) =>
      attempt < 1 &&
      [
        Code.Unavailable,
        Code.DeadlineExceeded,
        Code.ResourceExhausted,
        Code.Internal,
        Code.Unknown,
      ].includes(ConnectError.from(error).code),
    retryDelay: 500,
  });
}
