import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type Brand = { name: string; icon: string | LucideIcon; monochrome?: boolean };

export function BrandIcon({
  brand,
  className,
  ...props
}: ComponentProps<"span"> & { brand: Brand }) {
  const Icon = brand.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          {...props}
          role="img"
          aria-label={brand.name}
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card",
            className,
          )}
        >
          {typeof Icon === "string" ? (
            <img
              src={Icon}
              alt=""
              aria-hidden="true"
              className={cn(
                "size-5 max-h-[70%] max-w-[70%] object-contain",
                brand.monochrome && "dark:invert",
              )}
            />
          ) : (
            <Icon aria-hidden="true" className="size-5" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{brand.name}</TooltipContent>
    </Tooltip>
  );
}
