import {
  type McpUiResourceCsp,
  McpUiResourceMetaSchema,
} from "@modelcontextprotocol/ext-apps/app-bridge";

/** Data resources remain within the sandbox; network origins and device permissions are excluded. */
export function appResourcePolicy(meta: unknown): McpUiResourceCsp {
  const result = McpUiResourceMetaSchema.safeParse(meta);
  return result.success && result.data.csp?.resourceDomains?.includes("data:")
    ? { resourceDomains: ["data:"] }
    : {};
}
