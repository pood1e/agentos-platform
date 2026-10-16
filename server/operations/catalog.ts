import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Tier = "read" | "write" | "unknown";

interface TierLists {
  readOnly?: string[];
  write?: string[];
  management?: string[];
  managementReadOnly?: string[];
  approval?: string[];
}

/** Tool tiers for managed environment projects and for platform MCP servers. */
export interface ToolCatalog {
  projects: Map<string, Map<string, Tier>>;
  servers: Map<string, Map<string, Tier>>;
  approvals: Map<string, Set<string>>;
}

function tiers(source: Record<string, TierLists> | null): Map<string, Map<string, Tier>> {
  return new Map(
    Object.entries(source ?? {}).map(([key, lists]) => [
      key,
      new Map<string, Tier>([
        ...(lists.readOnly ?? []).map((tool) => [tool, "read"] as const),
        ...(lists.managementReadOnly ?? []).map((tool) => [tool, "read"] as const),
        ...(lists.write ?? []).map((tool) => [tool, "write"] as const),
        ...(lists.management ?? []).map((tool) => [tool, "write"] as const),
      ]),
    ]),
  );
}

export function parseCatalog(projects: string, servers: string): ToolCatalog {
  const source = parse(projects) as Record<string, TierLists> | null;
  return {
    projects: tiers(source),
    servers: tiers(parse(servers)),
    approvals: new Map(
      Object.entries(source ?? {}).map(([project, lists]) => [
        project,
        new Set(lists.approval ?? lists.write ?? []),
      ]),
    ),
  };
}

export function requiresChangeReview(catalog: ToolCatalog, project: string, tool: string) {
  return (
    !catalog.projects.get(project)?.has(tool) || catalog.approvals.get(project)?.has(tool) === true
  );
}

export function loadCatalog(
  projectsPath = process.env.AGENTOS_TOOLSETS || "/etc/agentos/toolsets.yaml",
  serversPath = process.env.AGENTOS_PLATFORM_TOOLS || "/etc/agentos/platform-tools.yaml",
): ToolCatalog {
  return parseCatalog(readFileSync(projectsPath, "utf8"), readFileSync(serversPath, "utf8"));
}
