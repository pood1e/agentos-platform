import { Navigate, Outlet, useLocation } from "react-router";
import { useAccess } from "@/lib/access";
import { can } from "../../../shared/permissions.js";
import { managementCapability } from "../../lib/permissions.js";

export function AdvancedLayout() {
  const access = useAccess();
  const capability = managementCapability(useLocation().pathname);
  if (!access.data) return null;
  if (capability && !can(access.data, capability)) return <Navigate to="/chat" replace />;
  return (
    <div data-testid="advanced" className="flex min-h-0 flex-1 flex-col gap-5">
      <Outlet />
    </div>
  );
}
