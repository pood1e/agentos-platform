import { useQuery } from "@connectrpc/connect-query";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { toolText } from "./tool-label.js";

/** Uses the discovered description when a tool has no curated localization. */
export function useToolText() {
  const { data } = useQuery(ConsoleService.method.getConfiguration, {}, { staleTime: 60_000 });
  return (name: string) => {
    const base = name.split("__").at(-1) ?? name;
    const server = data?.toolServers.find((server) =>
      server.discoveredTools.some((tool) => tool.name === name || tool.name === base),
    );
    const tool = server?.discoveredTools.find((tool) => tool.name === name || tool.name === base);
    return { ...toolText(name, tool?.description), server: server?.ref };
  };
}
