const key = "agentos-conversation";

export const lastConversation = () => localStorage.getItem(key) ?? "";

export function rememberConversation(contextId: string, suffix: string) {
  if (contextId) localStorage.setItem(key, `/chat/${encodeURIComponent(contextId)}${suffix}`);
  else localStorage.removeItem(key);
}
