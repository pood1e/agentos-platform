import type { BindingView } from "../governance/bindings.js";
import { actorTokenHeader } from "./actor.js";
import { mcpAuthorization } from "./mcp.js";
import type { ExecutionRuntime } from "./runtime.js";
import type { WorkloadIdentity } from "./workloads.js";

/** Every MCP service shares one registration; the current template limits actual calls. */
export function platformToolAuthorization(
  execution: ExecutionRuntime,
  workloads: WorkloadIdentity,
  access: BindingView,
) {
  return mcpAuthorization(
    (token) =>
      execution.actor({ [actorTokenHeader]: `Bearer ${token}` }, workloads.config.mcpAudience),
    async (session, tool, target) => {
      const context = await execution.registry.resolve(session);
      const { role, engineer } = await execution.agentRole(session);
      const policy = await access();
      if (
        !target.serviceNames.length ||
        !target.serviceNames.every((service) =>
          role.tools.some(
            (binding) =>
              binding.server === service &&
              policy.selectedTool(binding, tool.name) &&
              policy.permitsTool(engineer, service, tool.name, context.write),
          ),
        )
      )
        throw new Error("Tool is outside the Agent service binding");
      return {};
    },
    async (session, request) => {
      if (session) await execution.registry.resolve(session);
      else {
        const headers: Record<string, string> = {};
        for (const header of request.headers) {
          const key = header.key.toLowerCase();
          if (headers[key]) throw new Error("Duplicate workload proof");
          headers[key] = new TextDecoder().decode(header.value);
        }
        await workloads.controller(headers, request.method);
      }
      return {};
    },
  );
}
