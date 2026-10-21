import { useQuery } from "@connectrpc/connect-query";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { toolText } from "./tool-label.js";
import { toolSource } from "./tool-source.js";

/** Uses the discovered description when a tool has no curated localization. */
export function useToolText() {
  const { data } = useQuery(ConsoleService.method.getConfiguration, {}, { staleTime: 60_000 });
  return (name: string) => {
    const { server, tool } = toolSource(data?.toolServers ?? [], name);
    return { ...toolText(name, tool?.description), server: server?.ref };
  };
}
