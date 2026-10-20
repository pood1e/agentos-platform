import { create, type JsonObject } from "@bufbuild/protobuf";
import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
} from "@kubernetes/client-node";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import { roleDefinition, templateSpec } from "../console/role-template.js";
import { toolBindings } from "../governance/bindings.js";
import type { KagentClients } from "../kagent/clients.js";
import { nativeInvocation } from "../kagent/invoke-session.js";
import type { KnowledgeConfig } from "../knowledge/service.js";
import { knowledgeService } from "../knowledge/service.js";
import { meta, resource } from "../management/native.js";
import { machineIdentities } from "../platform/machine-identities.js";
import { object, text } from "../read-model/decode/messages.js";
import { sessionTools } from "../team-sessions/tools.js";
import { sandboxCredentials } from "./credentials.js";
import { evaluationKeys } from "./keys.js";
import { frozenKnowledge } from "./knowledge.js";
import { type Variant, variantName, variantPrefix } from "./names.js";
import { evaluationClients } from "./scoped-clients.js";
import type { CandidateRecord } from "./store.js";
import { evaluationVariant } from "./variants.js";

interface SandboxConfiguration {
  namespace: string;
  workspace: string;
  release: string;
  platformMcpUrl: string;
  userId: string;
  knowledge: KnowledgeConfig;
}

export function evaluationSandboxes(
  config: KubeConfig,
  native: KagentClients,
  options: SandboxConfiguration,
) {
  const core = config.makeApiClient(CoreV1Api),
    custom = config.makeApiClient(CustomObjectsApi),
    api = KubernetesObjectApi.makeApiClient(config);
  const keys = evaluationKeys(config, options.namespace, options.workspace, options.release);
  const handlers = new Map<string, ReturnType<typeof sessionTools>>();
  const scoped = (id: string, variant: Variant) => {
    const prefix = variantPrefix(id, variant);
    const clients = evaluationClients(native, options.namespace, prefix);
    const identities = machineIdentities(config, options.namespace, options.release, {
      gatewayNamespace: options.workspace,
      collaborationService: "evaluation-collaboration",
      metadata: { service: "evaluation", agentPrefix: prefix, candidate: id, variant },
    });
    const knowledge = {
      ...options.knowledge,
      scope: {
        ...options.knowledge.scope,
        agentName: `${options.namespace}__NS__${variantName(prefix, "knowledge")}`,
        ttlDays: 1,
      },
    };
    return { prefix, clients, identities, knowledge };
  };
  async function apply(body: JsonObject, id: string) {
    const metadata: JsonObject = {
      ...meta(body),
      labels: { ...object(meta(body).labels), "agentos.dev/candidate": id },
    };
    const existing = await api
      .read({
        apiVersion: text(body.apiVersion),
        kind: text(body.kind),
        metadata: { name: text(metadata.name), namespace: text(metadata.namespace) },
      })
      .catch((error: unknown) => {
        if (error instanceof ApiException && error.code === 404) return undefined;
        throw error;
      });
    if (existing && existing.metadata?.labels?.["agentos.dev/candidate"] !== id)
      throw new Error("Evaluation resource belongs to another candidate");
    return api.patch(
      { ...body, metadata },
      undefined,
      undefined,
      "agentos-evaluations",
      false,
      PatchStrategy.ServerSideApply,
    );
  }
  const copyCredentials = sandboxCredentials(core, options.workspace, options.namespace, apply);
  const seedKnowledge = frozenKnowledge(core, native, options.namespace, options.knowledge);
  async function prepare(record: CandidateRecord) {
    await keys.issue(`candidate-${record.candidate.id}-access`, record.candidate.id, {
      service: "evaluator",
      workspace: options.namespace,
      candidate: record.candidate.id,
    });
    const parameters: JsonObject = await custom.getNamespacedCustomObject({
      group: "agentgateway.dev",
      version: "v1alpha1",
      plural: "agentgatewayparameters",
      namespace: options.workspace,
      name: `${options.release}-gateway`,
    });
    for (const variant of ["candidate", "released"] as const) {
      const { prefix, identities, knowledge } = scoped(record.candidate.id, variant);
      const { resources, gatewayName } = evaluationVariant(
        record.snapshot,
        variant,
        options.namespace,
        prefix,
        options.platformMcpUrl,
      );
      await keys.issue(
        `${prefix}models`,
        record.candidate.id,
        { service: "evaluation-models" },
        gatewayName,
      );
      await keys.issue(`${prefix}invoke`, record.candidate.id, {
        service: "evaluation",
        workspace: options.namespace,
        agentPrefix: prefix,
        candidate: record.candidate.id,
        variant,
        tools: { "kagent-collaboration": ["invoke_session", "list_sessions"] },
      });
      await apply(
        {
          apiVersion: "agentgateway.dev/v1alpha1",
          kind: "AgentgatewayParameters",
          metadata: { name: gatewayName, namespace: options.namespace },
          spec: parameters.spec,
        },
        record.candidate.id,
      );
      await apply(
        {
          apiVersion: "gateway.networking.k8s.io/v1",
          kind: "Gateway",
          metadata: { name: gatewayName, namespace: options.namespace },
          spec: {
            gatewayClassName: "agentgateway",
            infrastructure: {
              parametersRef: {
                group: "agentgateway.dev",
                kind: "AgentgatewayParameters",
                name: gatewayName,
              },
            },
            listeners: [
              {
                name: "http",
                port: 8080,
                protocol: "HTTP",
                allowedRoutes: {
                  namespaces: { from: "Same" },
                  kinds: [{ group: "agentgateway.dev", kind: "AgentgatewayModel" }],
                },
              },
            ],
          },
        },
        record.candidate.id,
      );
      await apply(
        {
          apiVersion: "agentgateway.dev/v1alpha1",
          kind: "AgentgatewayPolicy",
          metadata: { name: gatewayName, namespace: options.namespace },
          spec: {
            targetRefs: [
              { group: "gateway.networking.k8s.io", kind: "Gateway", name: gatewayName },
            ],
            traffic: {
              apiKeyAuthentication: {
                mode: "Strict",
                location: {
                  expression:
                    "'authorization' in request.headers ? request.headers['authorization'].replace('Bearer ', '') : ('x-api-key' in request.headers ? request.headers['x-api-key'] : '')",
                },
                configMapSelector: { matchLabels: { "agentos.dev/gateway-keys": gatewayName } },
              },
              authorization: {
                action: "Require",
                policy: {
                  matchExpressions: [
                    "has(apiKey.service) && apiKey.service == 'evaluation-models' && request.path.matches('^/v1/(responses|chat/completions|messages|embeddings|models)(/.*)?$')",
                  ],
                },
              },
              headerModifiers: { request: { remove: ["authorization", "x-api-key"] } },
            },
          },
        },
        record.candidate.id,
      );
      const order = [
        "Harness",
        "ModelConfig",
        "AgentgatewayModel",
        "RemoteMCPServer",
        "AgentTemplate",
        "Agent",
      ];
      for (let value of resources.sort(
        (a, b) => order.indexOf(text(a.kind)) - order.indexOf(text(b.kind)),
      )) {
        if (
          value.kind === "RemoteMCPServer" &&
          !object(meta(value).labels)["agentos.dev/environment"]
        )
          continue;
        if (value.kind === "AgentgatewayModel" || value.kind === "RemoteMCPServer")
          await copyCredentials(value, prefix, record, variant);
        if (value.kind === "AgentTemplate") {
          const role = roleDefinition(
            create(AgentTemplateSchema, {
              ref: { namespace: options.namespace, name: text(meta(value).name) },
              resource: resource(value),
            }),
          );
          role.tools = role.tools.map((binding) => ({
            ...binding,
            tools: binding.tools.filter(
              (name) => !["prepare_role", "dispatch_session"].includes(name),
            ),
          }));
          const tools = await identities.bind(role.name, role.tools);
          value = { ...value, spec: templateSpec({ ...role, tools }, object(value.spec)) };
        }
        await apply(value, record.candidate.id);
      }
      await seedKnowledge(record, knowledge);
    }
  }
  async function handler(id: string, variant: Variant, role: string) {
    const { prefix, clients, identities, knowledge } = scoped(id, variant);
    if (!role.startsWith(prefix)) throw new Error("Role is outside this evaluation");
    const cacheKey = `${id}:${variant}`;
    if (!handlers.has(cacheKey)) {
      handlers.set(
        cacheKey,
        sessionTools(
          clients,
          options.namespace,
          toolBindings(config, options.namespace),
          knowledgeService(native, knowledge),
        ),
      );
    }
    return { scopes: await identities.authorize(role, clients), handler: handlers.get(cacheKey) };
  }
  async function invoke(id: string, variant: Variant) {
    const { prefix } = scoped(id, variant);
    const secret = await core.readNamespacedSecret({
      namespace: options.namespace,
      name: `${prefix}invoke`,
    });
    return nativeInvocation(
      new URL("/mcp/evaluation-collaboration", options.platformMcpUrl),
      Buffer.from(secret.data?.["api-key"] ?? "", "base64").toString(),
      options.userId,
    );
  }
  const release = (id: string) => {
    for (const key of handlers.keys()) if (key.startsWith(`${id}:`)) handlers.delete(key);
  };
  return { prepare, handler, invoke, keys, scoped, release };
}
