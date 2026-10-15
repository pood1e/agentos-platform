const key = "agentos-chat";

export const lastConversation = () => localStorage.getItem(key) ?? "";

export function rememberConversation(contextId: string) {
  if (contextId) localStorage.setItem(key, contextId);
  else localStorage.removeItem(key);
}
