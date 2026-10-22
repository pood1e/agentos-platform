import { Navigate, Outlet, useLocation } from "react-router";
import { useAccess } from "@/lib/access";
import { canViewManagementPage } from "../../lib/permissions.js";

export function AdvancedLayout() {
  const access = useAccess();
  const path = useLocation().pathname;
  if (!access.data) return null;
  if (!canViewManagementPage(path, access.data)) return <Navigate to="/chat" replace />;
  return (
    <div data-testid="advanced" className="flex min-h-0 flex-1 flex-col gap-5">
      <Outlet />
    </div>
  );
}
