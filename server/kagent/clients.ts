import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { A2AService } from "../../gen/a2a_pb.js";
import { AgentTemplateService } from "../../gen/kagent/api/v1alpha1/agent_templates_pb.js";
import { AgentService } from "../../gen/kagent/api/v1alpha1/agents_pb.js";
import { HarnessService } from "../../gen/kagent/api/v1alpha1/harnesses_pb.js";
import { MemoryService } from "../../gen/kagent/api/v1alpha1/memory_pb.js";
import { ModelService } from "../../gen/kagent/api/v1alpha1/models_pb.js";
import { SessionService } from "../../gen/kagent/api/v1alpha1/sessions_pb.js";
import { ToolService } from "../../gen/kagent/api/v1alpha1/tools_pb.js";
import type { KagentConfig } from "../shared/config.js";

export function kagentTransport(config: KagentConfig): Transport {
  return createGrpcTransport({
    baseUrl: config.url,
    interceptors: [
      (next) => (request) => {
        request.header.set("X-User-Id", config.userId);
        if (config.token) request.header.set("Authorization", `Bearer ${config.token}`);
        return next(request);
      },
    ],
  });
}

export function kagentClients(transport: Transport) {
  return {
    memory: createClient(MemoryService, transport),
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

/** Visits every page; a repeated token means the upstream cursor is broken. */
export async function eachPage<T>(
  fetchPage: (token: string) => Promise<{ items: T[]; token: string }>,
  visit: (items: T[]) => void,
): Promise<void> {
  const seen = new Set<string>();
  let token = "";
  do {
    if (seen.has(token)) throw new Error("Upstream pagination repeated a page token");
    seen.add(token);
    const page = await fetchPage(token);
    visit(page.items);
    token = page.token;
  } while (token);
}

/** Runs at most `size` calls at once and rethrows the first failure after all settle. */
export async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  const queue = [...items];
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
