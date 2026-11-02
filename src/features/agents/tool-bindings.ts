import { clone, create } from "@bufbuild/protobuf";
import { type ToolBinding, ToolBindingSchema } from "../../../gen/agentos/console/v1/role_pb.js";

export const hasTool = (bindings: ToolBinding[], server: string, tool: string) =>
  bindings.some((binding) => binding.server === server && binding.tools.includes(tool));

/** Approval follows target execution requirements; publication rechecks the same policy. */
export function toggleTool(
  bindings: ToolBinding[],
  requireApproval: boolean,
  server: string,
  tool: string,
  enabled: boolean,
) {
  const next = bindings.map((binding) => clone(ToolBindingSchema, binding));
  for (const binding of next)
    if (binding.server === server) binding.tools = binding.tools.filter((item) => item !== tool);
  if (enabled) {
    const binding = next.find(
      (item) => item.server === server && item.requireApproval === requireApproval,
    );
    if (binding) binding.tools.push(tool);
    else next.push(create(ToolBindingSchema, { server, tools: [tool], requireApproval }));
  }
  return next.filter((binding) => binding.tools.length);
}
