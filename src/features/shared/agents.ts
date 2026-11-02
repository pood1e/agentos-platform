import type { AgentSummary } from "../../../gen/agentos/console/v1/agent_pb.js";
import i18n, { tr } from "../../i18n/index.js";

const localized = (key: string) => (i18n.exists(key) ? tr(key) : undefined);

export function roleLabel(role: string): string {
  if (!role) return tr("team.noReferencedTemplate");
  return localized(`role.${role}.shortName`) ?? localized(`role.${role}.name`) ?? role;
}

/** Localized preset names apply only when the Agent and template share an identity. */
export function agentName(agent: Pick<AgentSummary, "id" | "name" | "template">): string {
  const name = agent.id.split("/").at(-1) ?? agent.id;
  return (
    agent.name ||
    (name === agent.template?.name ? localized(`role.${name}.name`) : undefined) ||
    name
  );
}

export function agentDescription(
  agent: Pick<AgentSummary, "name" | "template" | "description">,
  fallback = "",
): string {
  const preset = agent.name
    ? undefined
    : localized(`role.${agent.template?.name ?? ""}.description`);
  return preset ?? (fallback || agent.description);
}
