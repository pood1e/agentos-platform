import { Outlet } from "react-router";
import { useAccess } from "@/lib/access";

export function AdvancedLayout() {
  if (!useAccess().data?.manage) return null;
  return (
    <div data-testid="advanced" className="flex min-h-0 flex-1 flex-col gap-5">
      <Outlet />
    </div>
  );
}
