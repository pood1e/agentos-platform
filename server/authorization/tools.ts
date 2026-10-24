import { Code, ConnectError } from "@connectrpc/connect";
import type { RoleDefinition } from "../../gen/agentos/console/v1/role_pb.js";
import { toolBaseName } from "../../shared/tool-name.js";
import type { ToolBindings } from "../governance/bindings.js";

export function authorizeToolSelection(
  policy: ToolBindings,
  engineer: string,
  role: Pick<RoleDefinition, "tools">,
  tools: string[],
  write: boolean,
) {
  for (const tool of tools) {
    const name = toolBaseName(tool);
    const selected = role.tools.filter((binding) => policy.selectedTool(binding, name));
    if (selected.some((binding) => policy.permitsTool(engineer, binding.server, name, write)))
      continue;
    const readOnly =
      !write &&
      selected.some((binding) => policy.permitsTool(engineer, binding.server, name, true));
    throw new ConnectError(
      readOnly
        ? "This execution has read-only permissions"
        : "This Agent is not permitted to call this tool",
      Code.PermissionDenied,
    );
  }
}
