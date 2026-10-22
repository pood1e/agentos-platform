import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { can } from "../../shared/permissions.js";

export function canViewManagementPage(path: string, profile: Parameters<typeof can>[0]) {
  return (
    !!profile &&
    (path.replace(/\/+$/, "") !== "/engineers/evaluation" ||
      can(profile, Capability.EVALUATIONS_MANAGE))
  );
}
