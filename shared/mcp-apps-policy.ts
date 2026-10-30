import {
  type McpUiResourceCsp,
  McpUiResourceMetaSchema,
} from "@modelcontextprotocol/ext-apps/app-bridge";

/** The sandbox's site allowlist further restricts these image origins. */
export function appResourcePolicy(meta: unknown): McpUiResourceCsp {
  const result = McpUiResourceMetaSchema.safeParse(meta);
  if (!result.success) return {};
  const domains = (result.data.csp?.resourceDomains ?? []).flatMap((domain) => {
    if (domain === "data:") return [domain];
    try {
      const url = new URL(domain);
      return url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.href === `${url.origin}/`
        ? [url.origin]
        : [];
    } catch {
      return [];
    }
  });
  return domains.length ? { resourceDomains: [...new Set(domains)] } : {};
}
