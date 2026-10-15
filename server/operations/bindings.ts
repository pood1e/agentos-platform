import { create, type JsonObject } from "@bufbuild/protobuf";
import { CustomObjectsApi, type KubeConfig } from "@kubernetes/client-node";
import { type ToolBinding, ToolBindingSchema } from "../../gen/agentos/console/v1/role_pb.js";
import { ToolRequirementSchema } from "../../gen/agentos/console/v1/tool_pb.js";
import type { ToolServer } from "../../gen/kagent/api/v1alpha1/tools_pb.js";
import { object, text } from "../read-model/decode/messages.js";
import { loadCatalog, type ToolCatalog } from "./catalog.js";

interface Target {
  engineer: string;
  catalog: boolean;
  project: string;
  service: string;
  environment: string;
  governance: string;
  access: string;
}

export function serverTargets(backends: JsonObject[]) {
  const services = new Map(
    backends.flatMap((backend) => {
      const metadata = object(backend.metadata),
        labels = object(metadata.labels);
      return labels["agentos.dev/project"] && !labels["agentos.dev/engineer"]
        ? [
            [
              text(metadata.name),
              {
                project: text(labels["agentos.dev/project"]),
                environment: text(labels["agentos.dev/environment"]),
                governance: text(labels["agentos.dev/governance"]),
              },
            ] as const,
          ]
        : [];
    }),
  );
  const targets = new Map<string, Target>();
  for (const [name, service] of services)
    targets.set(name, { ...service, service: name, engineer: "", catalog: true, access: "" });
  for (const backend of backends) {
    const metadata = object(backend.metadata),
      engineer = text(object(metadata.labels)["agentos.dev/engineer"]);
    const entries = object(object(backend.spec).mcp).targets;
    const name = text(object(Array.isArray(entries) ? entries[0] : undefined).name);
    const service = services.get(name);
    if (engineer && service)
      targets.set(text(metadata.name), {
        ...service,
        service: name,
        engineer,
        catalog: false,
        access: text(object(metadata.labels)["agentos.dev/tool-access"]),
      });
  }
  return targets;
}

/** Selects engineer credentials and execution pauses; resource access stays with each target system. */
export class ToolBindings {
  constructor(
    private catalog: ToolCatalog,
    private targets: Map<string, Target>,
  ) {}

  usable(engineer: string, server: string) {
    const target = this.targets.get(server);
    return !target || (!target.catalog && target.engineer === engineer);
  }

  private writes(server: string, tool: string) {
    const target = this.targets.get(server);
    const name =
      target && tool.startsWith(`${target.service}_`)
        ? tool.slice(target.service.length + 1)
        : tool;
    return (
      (target ? this.catalog.projects.get(target.project) : this.catalog.servers.get(server))?.get(
        name,
      ) !== "read"
    );
  }

  requiresApproval(server: string, tool: string) {
    return this.targets.get(server)?.governance !== "direct" && this.writes(server, tool);
  }

  requirements(engineer: string, servers: ToolServer[]) {
    return servers.flatMap((server) => {
      const name = server.ref.split("/").at(-1) ?? server.ref;
      return this.usable(engineer, name)
        ? server.discoveredTools
            .filter((tool) =>
              this.targets.get(name)?.environment
                ? this.targets.get(name)?.access ===
                  (this.writes(name, tool.name) ? "write" : "readOnly")
                : !this.requiresApproval(name, tool.name),
            )
            .map((tool) =>
              create(ToolRequirementSchema, {
                server: name,
                tool: tool.name,
                requireApproval: this.requiresApproval(name, tool.name),
              }),
            )
        : [];
    });
  }

  bindings(
    engineer: string,
    bindings: ToolBinding[],
    servers: ToolServer[],
    strict: boolean,
  ): ToolBinding[] | undefined {
    const groups = new Map<string, ToolBinding>();
    for (const binding of bindings) {
      for (const name of binding.tools) {
        const requireApproval = this.requiresApproval(binding.server, name);
        const target = this.targets.get(binding.server);
        const view = target?.environment
          ? [...this.targets].find(
              ([, candidate]) =>
                candidate.service === target.service &&
                candidate.engineer === engineer &&
                candidate.access === (this.writes(binding.server, name) ? "write" : "readOnly"),
            )?.[0]
          : binding.server;
        const server = servers.find((item) => item.ref.split("/").at(-1) === view);
        if (
          !this.usable(engineer, binding.server) ||
          !view ||
          (strict && !server?.discoveredTools.some((tool) => tool.name === name))
        ) {
          if (strict) return undefined;
          continue;
        }
        const key = `${view}:${requireApproval}`;
        if (requireApproval && !this.targets.get(binding.server)?.environment) {
          if (strict) return undefined;
          continue;
        }
        const group =
          groups.get(key) ?? create(ToolBindingSchema, { server: view, requireApproval });
        group.tools.push(name);
        groups.set(key, group);
      }
    }
    return [...groups.values()];
  }
}

export function toolBindings(config: KubeConfig, namespace: string, catalog?: ToolCatalog) {
  const api = config.makeApiClient(CustomObjectsApi);
  const tools = catalog ?? loadCatalog();
  return async () => {
    const response = (await api.listNamespacedCustomObject({
      group: "agentgateway.dev",
      version: "v1alpha1",
      plural: "agentgatewaybackends",
      namespace,
    })) as { items: JsonObject[] };
    return new ToolBindings(tools, serverTargets(response.items));
  };
}

export type BindingView = ReturnType<typeof toolBindings>;
