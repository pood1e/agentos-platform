import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";

const pages = new Map([
  ["/engineers", Capability.AGENTS_MANAGE],
  ["/engineers/skills", Capability.SKILLS_MANAGE],
  ["/engineers/mcp", Capability.MCP_MANAGE],
  ["/engineers/models", Capability.MODELS_MANAGE],
  ["/engineers/harnesses", Capability.HARNESSES_MANAGE],
  ["/engineers/knowledge", Capability.KNOWLEDGE_MANAGE],
  ["/engineers/evaluation", Capability.EVALUATIONS_MANAGE],
]);

export const managementCapability = (path: string) => pages.get(path.replace(/\/+$/, ""));
