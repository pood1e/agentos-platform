import { createHash, randomBytes } from "node:crypto";
import { create, type JsonObject } from "@bufbuild/protobuf";
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
} from "@kubernetes/client-node";
import type { ToolBinding } from "../../gen/agentos/console/v1/role_pb.js";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { engineerServer, logicalPlatformServer } from "../../shared/platform-tools.js";
import { roleDefinition, templateSpec } from "../console/role-template.js";
import type { TemplateWriter } from "../console/template-writer.js";
import { serverTargets } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { object } from "../read-model/decode/messages.js";

/** Native gateway API keys are scoped to one workspace, role and configured tool subset. */
export function machineIdentities(
  config: KubeConfig,
  namespace: string,
  release: string,
  scope: {
    gatewayNamespace?: string;
    metadata?: JsonObject;
    collaborationService?: string;
  } = {},
) {
  const core = config.makeApiClient(CoreV1Api);
  const custom = config.makeApiClient(CustomObjectsApi);
  const resources = KubernetesObjectApi.makeApiClient(config);
  const gatewayNamespace = scope.gatewayNamespace ?? namespace;
  const labels = (role: string) => ({
    "agentos.dev/platform-role": role,
    "agentos.dev/gateway-keys": release,
    ...(typeof scope.metadata?.candidate === "string"
      ? { "agentos.dev/candidate": scope.metadata.candidate }
      : {}),
  });
  async function bind(role: string, bindings: ToolBinding[]): Promise<ToolBinding[]> {
    const backends: { items: JsonObject[] } = await custom.listNamespacedCustomObject({
      group: "agentgateway.dev",
      version: "v1alpha1",
      plural: "agentgatewaybackends",
      namespace: gatewayNamespace,
    });
    const environments = serverTargets(backends.items);
    const remotes: { items: JsonObject[] } = await custom.listNamespacedCustomObject({
      group: "api.kagent.dev",
      version: "v1alpha3",
      plural: "remotemcpservers",
      namespace,
    });
    const environmentServers = new Set(
      remotes.items
        .filter((remote) => object(object(remote.metadata).labels)["agentos.dev/environment"])
        .map((remote) => String(object(remote.metadata).name)),
    );
    const selected = bindings.filter(
      (binding) =>
        !environments.has(logicalPlatformServer(binding.server, role)) &&
        !environmentServers.has(binding.server),
    );
    const name = `${release}-role-${role}`;
    const existing = await core
      .readNamespacedSecret({ namespace, name })
      .catch((error: unknown) => {
        if (error instanceof ApiException && error.code === 404) return undefined;
        throw error;
      });
    if (existing && existing.metadata?.labels?.["agentos.dev/platform-role"] !== role)
      throw new Error("Machine credential belongs to another resource");
    if (!selected.length && !existing) return bindings;
    const token = existing?.data?.["api-key"]
      ? Buffer.from(existing.data["api-key"], "base64").toString()
      : randomBytes(32).toString("base64url");
    if (!existing)
      await core.createNamespacedSecret({
        namespace,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name, namespace, labels: labels(role) },
          type: "Opaque",
          stringData: { "api-key": token, authorization: `Bearer ${token}` },
        },
      });
    const tools: Record<string, string[]> = {};
    for (const binding of selected) {
      const service = logicalPlatformServer(binding.server, role);
      tools[service] = [...new Set([...(tools[service] ?? []), ...binding.tools])];
    }
    await resources.patch(
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace: gatewayNamespace, labels: labels(role) },
        data: {
          role: JSON.stringify({
            keyHash: `sha256:${createHash("sha256").update(token).digest("hex")}`,
            metadata: {
              service: "engineer",
              workspace: namespace,
              engineer: role,
              ...scope.metadata,
              tools,
            },
          }),
        },
      },
      undefined,
      undefined,
      "agentos-identities",
      false,
      PatchStrategy.ServerSideApply,
    );
    for (const binding of selected) {
      const service = logicalPlatformServer(binding.server, role);
      const remoteName = engineerServer(service, role);
      await resources.patch(
        {
          apiVersion: "api.kagent.dev/v1alpha3",
          kind: "RemoteMCPServer",
          metadata: {
            name: remoteName,
            namespace,
            labels: {
              "agentos.dev/platform-role": role,
              "agentos.dev/platform-service": service,
              ...(typeof scope.metadata?.candidate === "string"
                ? { "agentos.dev/candidate": scope.metadata.candidate }
                : {}),
            },
          },
          spec: {
            description: `${service}; ${role}`,
            url: `http://${release}-mcp-gateway.${gatewayNamespace}.svc:8080/mcp/${service === "kagent-collaboration" ? (scope.collaborationService ?? service) : service}`,
            protocol: "STREAMABLE_HTTP",
            timeout: "10m",
            sseReadTimeout: "10m",
            headersFrom: [
              {
                name: "Authorization",
                valueFrom: { type: "Secret", name, key: "authorization" },
              },
            ],
          },
        },
        undefined,
        undefined,
        "agentos-identities",
        false,
        PatchStrategy.ServerSideApply,
      );
    }
    return bindings.map((binding) =>
      selected.includes(binding)
        ? { ...binding, server: engineerServer(logicalPlatformServer(binding.server, role), role) }
        : binding,
    );
  }
  async function align(clients: KagentClients, replace: TemplateWriter) {
    const { agentTemplates } = await clients.templates.listAgentTemplates(
      { namespace },
      { timeoutMs: 10_000 },
    );
    for (const template of agentTemplates) {
      const role = roleDefinition(template);
      const tools = await bind(role.name, role.tools);
      const value = template.resource?.value;
      if (!value || !template.resource) continue;
      const spec = templateSpec({ ...role, tools }, object(value.spec));
      if (JSON.stringify(spec.tools) === JSON.stringify(object(value.spec).tools)) continue;
      await replace(
        create(AgentTemplateSchema, {
          ref: template.ref,
          resource: {
            apiVersion: template.resource.apiVersion,
            kind: template.resource.kind,
            value: { ...value, spec },
          },
        }),
      );
    }
  }
  async function authorize(role: string, clients: KagentClients) {
    if (!role || !/^[a-z0-9][a-z0-9-]*$/.test(role)) throw new Error("Machine role is required");
    const { agentTemplate } = await clients.templates.getAgentTemplate(
      { ref: { namespace, name: role } },
      { timeoutMs: 10_000 },
    );
    if (!agentTemplate) throw new Error("Unknown machine role");
    return roleDefinition(agentTemplate)
      .tools.filter((binding) => binding.server === "team-sessions")
      .flatMap((binding) => binding.tools);
  }
  return { bind, align, authorize };
}
