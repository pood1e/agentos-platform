import type { Engineer } from "../../../gen/agentos/console/v1/engineer_pb.js";
import i18n, { tr } from "../../i18n/index.js";

const localized = (key: string) => (i18n.exists(key) ? tr(key) : undefined);

export function roleLabel(role: string): string {
  if (!role) return tr("team.unassignedRole");
  return localized(`role.${role}.shortName`) ?? localized(`role.${role}.name`) ?? role;
}

/** Engineers without a display name are presets, named by their localized role. */
export function engineerName(engineer: Pick<Engineer, "id" | "name" | "role">): string {
  return (
    engineer.name ||
    localized(`role.${engineer.role}.name`) ||
    (engineer.id.split("/").at(-1) ?? engineer.id)
  );
}

export function engineerDescription(
  engineer: Pick<Engineer, "name" | "role" | "description">,
  fallback = "",
): string {
  const preset = engineer.name ? undefined : localized(`role.${engineer.role}.description`);
  return preset ?? (fallback || engineer.description);
}
