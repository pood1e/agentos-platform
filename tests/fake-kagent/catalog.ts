import { create } from "@bufbuild/protobuf";
import {
  type AgentTemplate,
  AgentTemplateSchema,
} from "../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import { type ToolServer, ToolServerSchema } from "../../gen/kagent/api/v1alpha1/tools_pb.js";

export const namespace = "agentos";

const server = (name: string, tools: string[]) =>
  create(ToolServerSchema, {
    ref: `${namespace}/${name}`,
    groupKind: "RemoteMCPServer.kagent.dev",
    discoveredTools: tools.map((tool) => ({ name: tool, description: `${tool} description` })),
  });

export const toolServers = (): ToolServer[] => [
  server("kagent-tool-server", [
    "k8s_get_resources",
    "k8s_describe_resource",
    "k8s_get_events",
    "k8s_get_pod_logs",
    "k8s_get_resource_yaml",
  ]),
  server("remediation-tools", ["k8s_apply_manifest"]),
  server("team-sessions", [
    "list_agents",
    "create_session",
    "dispatch_session",
    "search_knowledge",
  ]),
  server("kagent-collaboration", ["list_sessions", "invoke_session"]),
  server("grafana-mcp", ["grafana_query_loki"]),
];

const roles: Record<
  string,
  [string, string, { server: string; tools: string[]; approve: boolean }[]]
> = {
  coordinator: [
    "Coordinates the operation",
    "Plan and delegate.",
    [{ server: "team-sessions", tools: ["list_agents", "create_session"], approve: false }],
  ],
  inspection: [
    "Checks cluster health",
    "Inspect read-only.",
    [{ server: "kagent-tool-server", tools: ["k8s_get_resources"], approve: false }],
  ],
  diagnosis: ["Finds root causes", "Diagnose.", []],
  remediation: [
    "Applies approved changes",
    "Remediate with approval.",
    [{ server: "remediation-tools", tools: ["k8s_apply_manifest"], approve: true }],
  ],
  knowledge: ["Keeps verified knowledge", "Persist knowledge.", []],
};

export const templates = (): AgentTemplate[] =>
  Object.entries(roles).map(([name, [description, systemPrompt, bindings]], position) =>
    create(AgentTemplateSchema, {
      ref: { namespace, name },
      resource: {
        apiVersion: "api.kagent.dev/v1alpha3",
        kind: "AgentTemplate",
        value: {
          apiVersion: "api.kagent.dev/v1alpha3",
          kind: "AgentTemplate",
          metadata: { name, namespace, resourceVersion: String(100 + position) },
          spec: {
            description,
            systemPrompt,
            modelConfig: { name: "default-model-config" },
            tools: bindings.map((binding) => ({
              mcp: {
                server: { kind: "RemoteMCPServer", name: binding.server },
                tools: binding.tools,
                requireApproval: binding.approve,
              },
            })),
          },
        },
      },
    }),
  );
