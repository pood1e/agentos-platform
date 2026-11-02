import { requiredEnv } from "../shared/config.js";

export interface WorkspaceTarget {
  namespace: string;
  release: string;
  entryAgent: string;
  harness: string;
  kagentURL: string;
}

const name = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function workspaceTargets(env = process.env): WorkspaceTarget[] {
  const value: unknown = JSON.parse(requiredEnv("AGENTOS_WORKSPACES", env));
  if (!Array.isArray(value) || value.length === 0) throw new Error("AGENTOS_WORKSPACES is empty");
  const targets = value.map((entry): WorkspaceTarget => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid workspace target");
    const { namespace, release, entryAgent, harness, kagentURL } = entry;
    if (
      typeof namespace !== "string" ||
      typeof release !== "string" ||
      typeof entryAgent !== "string" ||
      typeof harness !== "string" ||
      typeof kagentURL !== "string" ||
      !name.test(namespace) ||
      !name.test(release) ||
      !name.test(entryAgent) ||
      !name.test(harness)
    )
      throw new Error("Invalid workspace target");
    const url = new URL(kagentURL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid workspace kagent URL");
    return {
      namespace,
      release,
      entryAgent,
      harness,
      kagentURL: url.toString().replace(/\/$/, ""),
    };
  });
  if (new Set(targets.map((target) => target.namespace)).size !== targets.length)
    throw new Error("Duplicate workspace namespace");
  return targets;
}
