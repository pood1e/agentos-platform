import type { IncomingHttpHeaders } from "node:http";
import type { ModelAuthorization } from "../../gen/agentos/authorization/v1/workload_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import type { KagentClients } from "../kagent/clients.js";
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
  const model = async (name: string) => {
    if (!name) throw new Error("A configured model is required");
    const { modelConfig } = await clients.models.getModelConfig(
      { ref: { namespace: workspace, name } },
      { timeoutMs: 5_000 },
    );
    if (!modelConfig) throw new Error("Model configuration is unavailable");
    return object(modelConfig.resource?.value?.spec);
  };
  const embedding = async (session: Session) => {
    const { agent } = await execution.agentRole(session);
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
      const { role } = await execution.agentRole(session);
      if (request.method === "GET" && request.path === "/v1/models") return;
      const isEmbedding = request.path === "/v1/embeddings";
      const selected = await model(
        isEmbedding ? await embedding(session) : (role.modelConfig?.name ?? ""),
      );
      const protocol =
        selected.provider === "Anthropic"
          ? ["/v1/messages", "/v1/messages/count_tokens"]
          : ["/v1/responses", "/v1/responses/compact", "/v1/chat/completions"];
      if (
        request.method !== "POST" ||
        text(selected.model) !== request.model ||
        (!isEmbedding && !protocol.includes(request.path))
      )
        throw new Error("Model API is outside the Agent configuration");
    } else {
      await workloads.model(headers);
      const selected = await model("knowledge-embedding");
      if (
        request.method !== "POST" ||
        request.path !== "/v1/embeddings" ||
        text(selected.model) !== request.model
      )
        throw new Error("Platform model identity is limited to knowledge embeddings");
    }
  };
}
