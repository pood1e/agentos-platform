import { create } from "@bufbuild/protobuf";
import { type ToolBinding, ToolBindingSchema } from "../gen/agentos/console/v1/role_pb.js";
import { type ToolRequirement, ToolRequirementSchema } from "../gen/agentos/console/v1/tool_pb.js";
import type { ToolServer } from "../gen/kagent/api/v1/tools_pb.js";
import type { AccessPlanStatus } from "../gen/kubernetes.js";

export type Target = NonNullable<AccessPlanStatus["targets"]>[number];

/** Runtime authorization consumes controller decisions without interpreting resource labels. */
export class ToolBindings {
  constructor(private readonly targets: Map<string, Target>) {}

  catalogs() {
    return [...this.targets.values()].filter(
      (target): target is Target & { environment: string; project: string } =>
        Boolean(target.catalog && target.environment && target.project),
    );
  }

  appSources() {
    return [...this.targets.values()].filter((target) => target.catalog || !target.environment);
  }

  appBinding(bindings: ToolBinding[], service: string, tools: string[]) {
    return bindings.find((binding) => {
      const target = this.targets.get(binding.server);
      return (
        target?.service === service &&
        tools.every(
          (tool) =>
            this.selectedTool(binding, tool) && this.decision(target, tool)?.write === false,
        )
      );
    });
  }

  catalogServer(server: ToolServer, servers: ToolServer[]) {
    const target = this.targets.get(server.ref.split("/").at(-1) ?? "");
    if (target?.access === "write") return server;
    return (
      servers.find(
        (candidate) => candidate.ref === `${server.ref.split("/")[0]}/${target?.service}`,
      ) ?? server
    );
  }

  connection(services: string[], environment: string, identity: string) {
    return (
      services.length > 0 &&
      services.every((service) =>
        [...this.targets.values()].some(
          (target) =>
            target.service === service &&
            target.environment === environment &&
            (identity === "catalog" ? target.catalog : target.engineer === identity),
        ),
      )
    );
  }

  usable(engineer: string, server: string) {
    const target = this.targets.get(server);
    return Boolean(target && !target.catalog && (!target.engineer || target.engineer === engineer));
  }

  private decision(target: Target | undefined, tool: string) {
    const name =
      target && tool.startsWith(`${target.service}_`)
        ? tool.slice(target.service.length + 1)
        : tool;
    return target?.tools?.find((entry) => entry.name === name);
  }

  tool(server: string, name: string) {
    return this.decision(this.targets.get(server), name);
  }

  readOnlyTool(name: string) {
    return [...this.targets.values()].some(
      (target) => !target.environment && this.decision(target, name)?.write === false,
    );
  }

  permitsCall(engineer: string, services: string[], tool: string, write: boolean) {
    return [...this.targets.values()].some((target) => {
      if (target.catalog || target.engineer !== engineer || !services.includes(target.service))
        return false;
      const decision = this.decision(target, tool);
      return Boolean(decision && (!decision.write || write));
    });
  }

  selectedCall(bindings: ToolBinding[], services: string[], tool: string) {
    return bindings.some((binding) => {
      const target = this.targets.get(binding.server);
      return target && services.includes(target.service) && this.selectedTool(binding, tool);
    });
  }

  selectedTool(binding: ToolBinding, tool: string) {
    const service = this.targets.get(binding.server)?.service ?? binding.server;
    const name = tool.startsWith(`${service}_`) ? tool.slice(service.length + 1) : tool;
    return binding.tools.some((selected) => selected === name || selected === `${service}_${name}`);
  }

  environmentCalls(bindings: ToolBinding[], tool: string, services?: string[]) {
    return bindings.flatMap((binding): Pick<ToolRequirement, "server" | "tool">[] => {
      const target = this.targets.get(binding.server);
      if (!target?.environment || (services && !services.includes(target.service))) return [];
      return binding.tools
        .filter((selected) => this.selectedTool({ ...binding, tools: [selected] }, tool))
        .map((selected) => ({ server: binding.server, tool: selected }));
    });
  }

  permitsTool(engineer: string, server: string, tool: string, write: boolean) {
    if (!this.usable(engineer, server)) return false;
    const decision = this.decision(this.targets.get(server), tool);
    return Boolean(decision && (!decision.write || write));
  }

  requiresApproval(server: string, tool: string) {
    return this.decision(this.targets.get(server), tool)?.requireApproval ?? true;
  }

  requirements(engineer: string, servers: ToolServer[]) {
    return servers.flatMap((server) => {
      const name = server.ref.split("/").at(-1) ?? server.ref;
      if (!this.usable(engineer, name)) return [];
      return server.discoveredTools.flatMap((tool) => {
        const decision = this.decision(this.targets.get(name), tool.name);
        return decision
          ? [
              create(ToolRequirementSchema, {
                server: name,
                tool: tool.name,
                requireApproval: decision.requireApproval,
              }),
            ]
          : [];
      });
    });
  }

  bindings(engineer: string, bindings: ToolBinding[], servers: ToolServer[], strict: boolean) {
    const groups = new Map<string, ToolBinding>();
    for (const binding of bindings) {
      const source = this.targets.get(binding.server);
      for (const name of binding.tools) {
        const target = source?.environment
          ? [...this.targets.values()].find(
              (candidate) =>
                candidate.service === source.service &&
                candidate.engineer === engineer &&
                this.decision(candidate, name),
            )
          : source;
        const decision = this.decision(target, name);
        const discovered = servers.find(
          (server) => server.ref.split("/").at(-1) === target?.server,
        );
        if (
          !source ||
          !this.usable(engineer, binding.server) ||
          !target ||
          !decision ||
          (strict && !discovered?.discoveredTools.some((tool) => tool.name === name))
        ) {
          if (strict) return undefined;
          continue;
        }
        const key = `${target.server}:${decision.requireApproval}`;
        const group =
          groups.get(key) ??
          create(ToolBindingSchema, {
            server: target.server,
            requireApproval: decision.requireApproval,
          });
        if (!group.tools.includes(name)) group.tools.push(name);
        groups.set(key, group);
      }
    }
    return [...groups.values()];
  }
}

export type BindingView = () => Promise<ToolBindings>;
