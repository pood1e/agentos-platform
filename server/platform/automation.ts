import { create, fromJson } from "@bufbuild/protobuf";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { TaskState } from "../../gen/a2a_pb.js";
import {
  type CaseReference,
  CaseReferenceSchema,
  CaseRequestSchema,
} from "../../gen/agentos/automation/v1/case_pb.js";
import { InvokeSessionOutputSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import referenceSchema from "../../gen/schema/agentos.automation.v1.CaseReference.jsonschema.bundle.json" with {
  type: "json",
};
import requestSchema from "../../gen/schema/agentos.automation.v1.CaseRequest.jsonschema.bundle.json" with {
  type: "json",
};
import type { KagentClients } from "../kagent/clients.js";
import type { nativeInvocation } from "../kagent/invoke-session.js";
import { agentInfo } from "../read-model/agents.js";
import { terminal } from "../read-model/state.js";
import type { KagentSync } from "../read-model/sync.js";
import { busy, foreground, taskTree } from "../read-model/tree.js";
import { messageIdentity } from "../shared/idempotency.js";
import { inputSchema, result, validator } from "../team-sessions/schema.js";

/** Source identities address cases; native session and task IDs are never accepted as inputs. */
export function automationTools(
  clients: KagentClients,
  sync: KagentSync,
  workspace: string,
  environment: string,
  invoke: ReturnType<typeof nativeInvocation>,
) {
  const messageId = (ref: CaseReference) =>
    messageIdentity(workspace, environment, ref.key, String(ref.version));
  async function session(ref: CaseReference) {
    const validation = validator.validate(CaseReferenceSchema, ref);
    if (validation.kind !== "valid") throw new Error("A versioned source case is required");
    const { agents } = await clients.agents.listAgents(
      { namespace: workspace },
      { timeoutMs: 15_000 },
    );
    const coordinators = agents.filter((agent) => agentInfo(agent).role === "coordinator");
    if (coordinators.length !== 1) throw new Error("Exactly one workspace coordinator is required");
    const { session } = await clients.sessions.createSession(
      {
        agent: coordinators[0]?.ref,
        requestId: messageIdentity("source-case", workspace, environment, ref.key),
        name: `Case ${messageIdentity(environment, ref.key).slice(0, 8)}`,
      },
      { timeoutMs: 60_000 },
    );
    if (!session) throw new Error("Native case session is missing");
    return session;
  }
  function observed(ref: CaseReference, sessionId: string) {
    if (!sync.healthy()) throw new Error("Native case history is rebuilding");
    const root = sync.index.taskOfMessage(messageId(ref));
    if (root && root.contextId !== sessionId) throw new Error("Native case context differs");
    const tree = root && taskTree(sync.index, root.id);
    const latest = tree?.latest ?? root;
    return {
      tree,
      output: create(InvokeSessionOutputSchema, {
        sessionId,
        contextId: sessionId,
        taskId: latest?.id,
        state: tree && busy(tree) ? TaskState.WORKING : (latest?.state ?? TaskState.WORKING),
        text: latest?.answer.slice(0, 4000) ?? "",
      }),
    };
  }
  return createMcpHandler(() => {
    const server = new McpServer({ name: "case-automation", version: "0.2.0" });
    server.registerTool(
      "run_case",
      {
        description:
          "Run one versioned source case with the workspace coordinator. Retries reuse its native session and message. Environment is fixed by the source identity.",
        inputSchema: inputSchema(requestSchema),
        annotations: { idempotentHint: true },
      },
      async (args, context) => {
        const request = fromJson(CaseRequestSchema, args);
        if (validator.validate(CaseRequestSchema, request).kind !== "valid" || !request.case)
          throw new Error("A versioned source case and concise task are required");
        const own = await session(request.case);
        const response = await invoke(
          own.id,
          messageId(request.case),
          `Environment: ${environment}\nSource case: ${request.case.key}\n${request.message}`,
          context.mcpReq.signal,
        );
        return response;
      },
    );
    server.registerTool(
      "observe_case",
      {
        description: "Read the native status and latest coordinator continuation of a source case.",
        inputSchema: inputSchema(referenceSchema),
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        const ref = fromJson(CaseReferenceSchema, args),
          own = await session(ref);
        return result(InvokeSessionOutputSchema, observed(ref, own.id).output);
      },
    );
    server.registerTool(
      "cancel_case",
      {
        description:
          "Cancel active native foreground tasks belonging to this source case. Already executed effects still require verification.",
        inputSchema: inputSchema(referenceSchema),
        annotations: { idempotentHint: true },
      },
      async (args) => {
        const ref = fromJson(CaseReferenceSchema, args),
          own = await session(ref);
        const current = observed(ref, own.id);
        if (current.tree)
          for (const entry of foreground(current.tree))
            if (!terminal(entry.state))
              await clients.a2a.cancelTask(
                { tenant: entry.agentId, id: entry.id },
                { timeoutMs: 30_000 },
              );
        return result(InvokeSessionOutputSchema, current.output);
      },
    );
    return server;
  });
}
