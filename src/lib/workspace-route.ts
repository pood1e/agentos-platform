import { create } from "@bufbuild/protobuf";
import {
  type WorkspaceAuthorizationReference,
  WorkspaceAuthorizationReferenceSchema,
} from "../../gen/kagent/api/v1/authorization_pb.js";

const namespace = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const uid = /^[A-Za-z0-9_-]{1,128}$/;

export function workspaceFromPath(pathname: string): WorkspaceAuthorizationReference | undefined {
  const match = /^\/w\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return;
  try {
    const name = decodeURIComponent(match[1]);
    const id = decodeURIComponent(match[2]);
    return namespace.test(name) && uid.test(id)
      ? create(WorkspaceAuthorizationReferenceSchema, { namespace: name, uid: id })
      : undefined;
  } catch {
    return undefined;
  }
}

export const workspaceBase = (workspace: WorkspaceAuthorizationReference) =>
  `/w/${encodeURIComponent(workspace.namespace)}/${encodeURIComponent(workspace.uid)}`;

export const workspaceURL = (workspace: WorkspaceAuthorizationReference) =>
  `${workspaceBase(workspace)}/chat`;

export const currentWorkspace =
  typeof window === "undefined" ? undefined : workspaceFromPath(window.location.pathname);
