import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { packAsset, usePack } from "@/lib/pack";
import { cn } from "@/lib/utils";

interface Brand {
  match: RegExp;
  name: string;
  src: string;
  monochrome?: boolean;
}

const platform: Brand[] = [
  {
    match:
      /kagent|team-sessions|delegate_coordinator|invoke_session|dispatch_session|list_sessions|create_session|list_agents|list_role_tools|prepare_role|search_knowledge|transfer_to_agent|(?:save|load|search|preload|prefetch)_memory|(?:list|load)_skill|^(?:ask_user|read_file|write_file|edit_file|bash|list_files|grep_file)$/i,
    name: "kagent",
    src: "/icons/kagent.svg",
  },
];

const fallback = { name: "MCP", src: "/icons/mcp.svg", monochrome: true };

/** Solution pack brands first, then the platform's own tools, then the generic MCP icon. */
function useBrands(): Brand[] {
  const { tools } = usePack();
  return useMemo(
    () => [
      ...tools.map((tool) => ({
        match: new RegExp(tool.match, "i"),
        name: tool.name,
        src: packAsset(tool.icon),
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
  return <BrandIcon brand={brand} className={className} />;
}

function BrandIcon({
  brand,
  className,
}: {
  brand: { name: string; src: string; monochrome?: boolean };
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="tool-icon"
          data-tool-brand={brand.name}
          role="img"
          aria-label={brand.name}
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card",
            className,
          )}
        >
          <img
            src={brand.src}
            alt=""
            aria-hidden="true"
            className={cn(
              "size-5 max-h-[70%] max-w-[70%] object-contain",
              brand.monochrome && "dark:invert",
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{brand.name}</TooltipContent>
    </Tooltip>
  );
}
