import type { WorkspaceAuthorizationReference } from "../../gen/kagent/api/v1/authorization_pb.js";
import { partialDirectoryHeader } from "../../shared/kagent-resources.js";
import { authorizationClient } from "./console.js";

export async function listWorkspaces(signal: AbortSignal) {
  const workspaces: WorkspaceAuthorizationReference[] = [];
  const tokens = new Set<string>();
  let partial = false;
  let pageToken = "";
  do {
    if (tokens.has(pageToken)) throw new Error("Workspace directory repeated a page token");
    tokens.add(pageToken);
    const page = await authorizationClient.listWorkspaces(
      { page: { limit: 50, pageToken } },
      {
        signal,
        timeoutMs: 15_000,
        onHeader: (headers) => {
          partial ||= headers.has(partialDirectoryHeader);
        },
      },
    );
    workspaces.push(...page.workspaces);
    pageToken = page.page?.nextPageToken ?? "";
  } while (pageToken);
  return { workspaces, partial };
}
