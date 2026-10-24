import type { AccessProfile } from "../../../gen/agentos/console/v1/access_pb.js";

const key = (profile: Pick<AccessProfile, "workspace" | "subject">) =>
  `agentos-conversation:${JSON.stringify([profile.workspace, profile.subject])}`;

export const lastConversation = (profile: AccessProfile) =>
  localStorage.getItem(key(profile)) ?? "";

export function rememberConversation(profile: AccessProfile, contextId: string) {
  if (contextId) localStorage.setItem(key(profile), `/chat/${encodeURIComponent(contextId)}`);
  else localStorage.removeItem(key(profile));
}

export function forgetConversation(profile: AccessProfile, contextId: string) {
  if (lastConversation(profile) === `/chat/${encodeURIComponent(contextId)}`)
    localStorage.removeItem(key(profile));
}
