import type { ToolServer } from "../../../gen/kagent/api/v1alpha1/tools_pb.js";

/** Gateway-qualified names identify the service shared by its credential profiles. */
export function toolSource(servers: ToolServer[], name: string) {
  const parts = name.split("__");
  const base = parts.at(-1) ?? name;
  const matches = (tool: { name: string }) => tool.name === name || tool.name === base;
  const candidates = servers.filter((server) => server.discoveredTools.some(matches));
  const qualified = candidates.filter((server) => {
    const service = server.ref.split("/").at(-1) ?? server.ref;
    return name.startsWith(`${service}_`) || parts.slice(0, -1).includes(service);
  });
  const server = qualified.sort((a, b) => b.ref.length - a.ref.length)[0] ?? candidates[0];
  return { server, tool: server?.discoveredTools.find(matches) };
}
