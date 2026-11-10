import { createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { A2AService } from "../../gen/a2a_pb.js";
import { AgentTemplateService } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import { AgentService } from "../../gen/kagent/api/v1/agents_pb.js";
import { AuthorizationService } from "../../gen/kagent/api/v1/authorization_pb.js";
import { ExecutionService } from "../../gen/kagent/api/v1/execution_pb.js";
import { HarnessService } from "../../gen/kagent/api/v1/harnesses_pb.js";
import { ModelService } from "../../gen/kagent/api/v1/models_pb.js";
import { SessionService } from "../../gen/kagent/api/v1/sessions_pb.js";
import { SystemService } from "../../gen/kagent/api/v1/system_pb.js";
import { TaskCatalogService } from "../../gen/kagent/api/v1/task_catalog_pb.js";
import { ToolService } from "../../gen/kagent/api/v1/tools_pb.js";
import { WorkflowService } from "../../gen/kagent/api/v1/workflows_pb.js";
import { rpcMetrics } from "../shared/telemetry.js";
import { nativeCredentials } from "./context.js";

/** kagent serves A2A 1.0 and treats an A2A call without A2A-Version as 0.3, which it rejects. */
export const a2aVersion: Interceptor = (next) => (request) => {
  if (request.service.typeName === A2AService.typeName) request.header.set("a2a-version", "1.0");
  return next(request);
};

export function kagentTransport(baseUrl: string): Transport {
  return createGrpcTransport({
    baseUrl,
    interceptors: [rpcMetrics("client"), nativeCredentials, a2aVersion],
  });
}

export function kagentClients(transport: Transport) {
  return {
    authorization: createClient(AuthorizationService, transport),
    workflows: createClient(WorkflowService, transport),
    catalog: createClient(TaskCatalogService, transport),
    execution: createClient(ExecutionService, transport),
    system: createClient(SystemService, transport),
    models: createClient(ModelService, transport),
    agents: createClient(AgentService, transport),
    harnesses: createClient(HarnessService, transport),
    sessions: createClient(SessionService, transport),
    a2a: createClient(A2AService, transport),
    templates: createClient(AgentTemplateService, transport),
    tools: createClient(ToolService, transport),
  };
}

export type KagentClients = ReturnType<typeof kagentClients>;
