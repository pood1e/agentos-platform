import { useMemo } from "react";
import { packAsset, usePack } from "@/lib/pack";
import { type Brand, BrandIcon } from "./BrandIcon.js";

interface ToolBrand extends Brand {
  match: RegExp;
  icon: string;
}

const platform: ToolBrand[] = [
  {
    match:
      /kagent|team-sessions|delegate_coordinator|invoke_session|dispatch_session|list_sessions|create_session|list_agents|list_role_tools|prepare_role|search_knowledge|transfer_to_agent|(?:save|load|search|preload|prefetch)_memory|(?:list|load)_skill|^(?:ask_user|read_file|write_file|edit_file|bash|list_files|grep_file)$/i,
    name: "kagent",
    icon: "/icons/kagent.svg",
  },
];

const fallback = { name: "MCP", icon: "/icons/mcp.svg", monochrome: true };

/** Solution pack brands first, then the platform's own tools, then the generic MCP icon. */
function useBrands(): ToolBrand[] {
  const { tools } = usePack();
  return useMemo(
    () => [
      ...tools.map((tool) => ({
        match: new RegExp(tool.match, "i"),
        name: tool.name,
        icon: packAsset(tool.icon),
        monochrome: tool.monochrome,
      })),
      ...platform,
    ],
    [tools],
  );
}

export function ToolIcon({
  name,
  server = "",
  className,
}: {
  name: string;
  server?: string;
  className?: string;
}) {
  const brands = useBrands();
  const brand =
    brands.find((item) => item.match.test(name)) ??
    brands.find((item) => item.match.test(server)) ??
    fallback;
  return (
    <BrandIcon
      brand={brand}
      className={className}
      data-testid="tool-icon"
      data-tool-brand={brand.name}
    />
  );
}
