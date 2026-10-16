export const platformServices = ["team-sessions", "kagent-collaboration"] as const;

export function logicalPlatformServer(server: string, role: string): string {
  return platformServices.find((service) => server === `${service}-${role}`) ?? server;
}

export function platformProfile(server: string) {
  const service = platformServices.find((name) => server.startsWith(`${name}-`));
  return service ? { service, role: server.slice(service.length + 1) } : undefined;
}
