import { useQuery } from "@tanstack/react-query";
import {
  type Connection,
  ConnectionKind,
} from "../../../gen/agentos/management/v1/management_pb.js";
import { managementClient } from "../../lib/console.js";

export function useMCPServices() {
  return useQuery({
    queryKey: ["management", "mcp-services"],
    queryFn: async () => {
      const connections: Connection[] = [];
      let pageToken = "";
      do {
        const response = await managementClient.listConnections({
          kind: ConnectionKind.MCP,
          pageSize: 100,
          pageToken,
        });
        connections.push(...response.connections);
        pageToken = response.nextPageToken;
      } while (pageToken);
      return connections;
    },
  });
}
