import { create } from "@bufbuild/protobuf";
import { type ToolBinding, ToolBindingSchema } from "../../gen/agentos/console/v1/role_pb.js";
import { ToolRequirementSchema } from "../../gen/agentos/console/v1/tool_pb.js";
import type { ToolServer } from "../../gen/kagent/api/v1/tools_pb.js";
import type { AccessPlanStatus } from "../../gen/kubernetes.js";
import { toolServerName } from "../../shared/kagent-resources.js";

export type Target = NonNullable<AccessPlanStatus["targets"]>[number];

/** The gateway may qualify a tool with its service; decisions use the bare name. */
export const unprefixedTool = (service: string, tool: string) =>
  tool.startsWith(`${service}_`) ? tool.slice(service.length + 1) : tool;

/** Runtime authorization consumes controller decisions without interpreting resource labels. */
export class ToolBindings {
  constructor(private readonly targets: Map<string, Target>) {}

  appSources() {
    return [...this.targets.values()].filter((target) => target.catalog || !target.environment);
  }

  serviceForRuntimeServer(name: string) {
    const matches = [...this.targets.values()].filter((target) => {
      const native = target.server.replaceAll(".", "_");
      return name === native || name === `${native}-approval`;
    });
    return matches.length === 1 ? matches[0].service : undefined;
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
    if (this.targets.get(toolServerName(server))?.access === "write") return server;
    return this.metadataServer(server, servers);
  }

  metadataServer(server: ToolServer, servers: ToolServer[]) {
    const target = this.targets.get(toolServerName(server));
    return (
      servers.find(
        (candidate) => candidate.ref === `${server.ref.split("/")[0]}/${target?.service}`,
      ) ?? server
    );
  }

  usable(identity: string, server: string) {
    const target = this.targets.get(server);
    return Boolean(
      target &&
        !target.catalog &&
        (target.environment
          ? target.identity === identity
          : !target.identity || target.identity === identity),
    );
  }

  private decision(target: Target | undefined, tool: string) {
    const name = target ? unprefixedTool(target.service, tool) : tool;
    return target?.tools?.find((entry) => entry.name === name);
  }

  private qualifiedName(target: Target, name: string) {
    return target.environment && !name.startsWith(`${target.service}_`)
      ? `${target.service}_${name}`
      : name;
  }

  private selectedTool(binding: ToolBinding, tool: string) {
    const service = this.targets.get(binding.server)?.service ?? binding.server;
    const name = unprefixedTool(service, tool);
    return binding.tools.some((selected) => selected === name || selected === `${service}_${name}`);
  }

  requirements(identity: string) {
    return [...this.targets.values()].flatMap((target) => {
      if (!this.usable(identity, target.server)) return [];
      return (target.tools ?? []).map((decision) =>
        create(ToolRequirementSchema, {
          server: target.server,
          tool: this.qualifiedName(target, decision.name),
          requireApproval: decision.requireApproval,
        }),
      );
    });
  }

  bindings(identity: string, bindings: ToolBinding[], mode: "validate" | "normalize") {
    const strict = mode === "validate";
    const groups = new Map<string, ToolBinding>();
    for (const binding of bindings) {
      const source = this.targets.get(binding.server);
      for (const name of binding.tools) {
        const target = source?.environment
          ? [...this.targets.values()].find(
              (candidate) =>
                candidate.service === source.service &&
                candidate.identity === identity &&
                this.decision(candidate, name),
            )
          : source;
        const decision = this.decision(target, name);
        if (
          !source ||
          !this.usable(identity, binding.server) ||
          !target ||
          !decision ||
          name !== this.qualifiedName(target, decision.name)
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
