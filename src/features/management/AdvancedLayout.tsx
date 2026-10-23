import { Outlet } from "react-router";

export function AdvancedLayout() {
  return (
    <div data-testid="advanced" className="flex min-h-0 flex-1 flex-col gap-5">
      <Outlet />
    </div>
  );
}
