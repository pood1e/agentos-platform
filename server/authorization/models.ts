import type { IncomingHttpHeaders } from "node:http";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ModelAuthorization } from "../../gen/agentos/authorization/v1/workload_pb.js";
import { ModelPurpose } from "../../gen/agentos/management/v1/management_pb.js";
import { modelPurpose } from "../../shared/model-purpose.js";
import type { KagentClients } from "../kagent/clients.js";
import { knowledgeModel } from "../knowledge/config.js";
import { object, text } from "../read-model/decode/messages.js";
import { actorTokenHeader } from "./actor.js";
import type { ExecutionRuntime } from "./runtime.js";
import type { WorkloadIdentity } from "./workloads.js";

/** HTTP model access is limited to the current Agent and Harness model configuration. */
export function modelAuthorization(
  clients: KagentClients,
  execution: ExecutionRuntime,
  workloads: WorkloadIdentity,
  workspace: string,
) {
  const model = async (name: string, purpose: ModelPurpose) => {
    if (!name) throw new ConnectError("A configured model is required", Code.PermissionDenied);
    const { modelConfig } = await clients.models.getModelConfig(
      { ref: { namespace: workspace, name } },
      { timeoutMs: 5_000 },
    );
    if (!modelConfig)
      throw new ConnectError("Model configuration is unavailable", Code.Unavailable);
    if (modelPurpose(modelConfig.resource?.value) !== purpose)
      throw new ConnectError("Model purpose does not match the API", Code.PermissionDenied);
    return object(modelConfig.resource?.value?.spec);
  };
  const embedding = async (agent: Awaited<ReturnType<ExecutionRuntime["agentRole"]>>["agent"]) => {
    const name = text(object(object(agent.resource?.value?.spec).harnessRef).name);
    const { harnesses } = await clients.harnesses.listHarnesses(
      { namespace: workspace },
      { timeoutMs: 5_000 },
    );
    const harness = harnesses.find((item) => item.ref?.name === name);
    return text(
      object(object(object(object(harness?.resource?.value?.spec).kagent).memory).modelConfigRef)
        .name,
    );
  };
  return async (request: ModelAuthorization, headers: IncomingHttpHeaders) => {
    if (headers[actorTokenHeader] !== undefined) {
      const session = await execution.actor(headers, workloads.config.modelAudience);
      await execution.registry.resolve(session);
      const { role, agent } = await execution.agentRole(session);
      if (request.method === "GET" && request.path === "/v1/models") return;
      const isEmbedding = request.path === "/v1/embeddings";
      const selected = await model(
        isEmbedding ? await embedding(agent) : (role.modelConfig?.name ?? ""),
        isEmbedding ? ModelPurpose.EMBEDDING : ModelPurpose.LANGUAGE,
      );
      const generation = [
        "/v1/messages",
        "/v1/messages/count_tokens",
        "/v1/responses",
        "/v1/responses/compact",
        "/v1/chat/completions",
      ];
      if (
        request.method !== "POST" ||
        text(selected.model) !== request.model ||
        (!isEmbedding && !generation.includes(request.path))
      )
        throw new ConnectError(
          "Model API is outside the Agent configuration",
          Code.PermissionDenied,
        );
    } else {
      await workloads.model(headers);
      const selected = await model(knowledgeModel, ModelPurpose.EMBEDDING);
      if (
        request.method !== "POST" ||
        request.path !== "/v1/embeddings" ||
        text(selected.model) !== request.model
      )
        throw new ConnectError(
          "Platform model identity is limited to knowledge embeddings",
          Code.PermissionDenied,
        );
    }
  };
}
