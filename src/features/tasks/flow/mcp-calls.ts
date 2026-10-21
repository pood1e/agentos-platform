import type { ToolCall } from "../../../../gen/agentos/execution/v1/task_pb.js";
import { millis } from "../../../lib/format.js";
import { currentState } from "./collaboration-flow.js";

/** MCP services are resolved from discovery; native and unresolved tools stay in execution details. */
export function mcpCalls(calls: ToolCall[], serverOf: (name: string) => string | undefined) {
  const groups = new Map<string, ToolCall[]>();
  for (const call of [...calls].sort(
    (a, b) => (millis(a.startedAt) ?? 0) - (millis(b.startedAt) ?? 0),
  )) {
    const server = serverOf(call.name);
    if (server) groups.set(server, [...(groups.get(server) ?? []), call]);
  }
  return [...groups].map(([server, calls]) => ({
    id: `server:${server}`,
    server,
    calls,
    state: currentState(calls.map((call) => call.state)),
  }));
}
