export const platformServices = ["team-sessions", "kagent-collaboration"] as const;

export function logicalPlatformServer(server: string, role: string): string {
  const profile = platformProfile(server);
  return profile?.role === role ? profile.service : server;
}

export function platformProfile(server: string) {
  const match = /^engineer-([a-z0-9-]+)--([a-z0-9][a-z0-9.-]*)$/.exec(server);
  return match ? { role: match[1], service: match[2] } : undefined;
}

export const engineerServer = (service: string, role: string) => `engineer-${role}--${service}`;
