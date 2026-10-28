import { create, fromJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MessageSchema, Role, TaskState } from "../../gen/a2a_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import {
  type ExecutionReference,
  ExecutionReferenceSchema,
  GetExecutionRequestSchema,
  GetExecutionResponseSchema,
  RunExecutionRequestSchema,
} from "../../gen/agentos/execution/v1/service_pb.js";
import { InvokeSessionOutputSchema } from "../../gen/kagent/api/v1/collaboration_pb.js";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import referenceSchema from "../../gen/schema/agentos.execution.v1.ExecutionReference.jsonschema.bundle.json" with {
  type: "json",
};
import getSchema from "../../gen/schema/agentos.execution.v1.GetExecutionRequest.jsonschema.bundle.json" with {
  type: "json",
};
import runSchema from "../../gen/schema/agentos.execution.v1.RunExecutionRequest.jsonschema.bundle.json" with {
  type: "json",
};
import { type Executions, relatedExecutions } from "../authorization/executions.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey, sessionInfo } from "../read-model/agents.js";
import { cancelTree } from "../read-model/cancel.js";
import { taskOutput } from "../read-model/decode/output.js";
import type { TaskProjection } from "../read-model/projection.js";
import { refreshSession } from "../read-model/reconcile.js";
import { busy, outcomeState, taskTree } from "../read-model/tree.js";
import { messageIdentity } from "../shared/idempotency.js";
import { inputSchema, result, validator } from "../team-sessions/schema.js";
import { executionResult } from "./results.js";

/** Machine callers use ordinary native executions; scheduling and workflow state stay outside. */
export function executionTools(
  clients: KagentClients,
  projection: TaskProjection,
  workspace: string,
  registry: Executions,
  identity: ExecutionIdentity,
  agents: ResourceReference[],
) {
  function reference(ref?: ExecutionReference) {
    if (
      !ref ||
      validator.validate(ExecutionReferenceSchema, ref).kind !== "valid" ||
      ref.agent?.namespace !== workspace ||
      !agents.some((agent) => agentKey(agent) === agentKey(ref.agent))
    )
      throw new ConnectError(
        "Execution Agent is outside the caller's binding",
        Code.PermissionDenied,
      );
    return {
      ref,
      messageId: messageIdentity(
        "external-execution",
        workspace,
        identity.subject,
        ref.requestId,
        agentKey(ref.agent),
      ),
    };
  }
  async function admitted(ref: ExecutionReference) {
    const { session } = await clients.sessions.createSession(
      {
        agent: ref.agent,
        requestId: messageIdentity(
          "external-session",
          workspace,
          identity.subject,
          ref.requestId,
          agentKey(ref.agent),
        ),
        name: `Execution ${ref.requestId}`,
      },
      { timeoutMs: 60_000 },
    );
    if (!session) throw new ConnectError("Native session is unavailable", Code.Unavailable);
    await registry.bind(session, identity);
    return session;
  }
  async function observed(ref?: ExecutionReference) {
    const target = reference(ref);
    const root = await projection.taskOfMessage(target.messageId);
    if (!root || root.agentId !== agentKey(target.ref.agent))
      throw new ConnectError("Execution not found", Code.NotFound);
    const { session } = await clients.sessions.getSession(
      { sessionId: root.contextId },
      { timeoutMs: 5_000 },
    );
    if (!session) throw new ConnectError("Execution not found", Code.NotFound);
    const { binding } = await registry.record(session, true);
    if (binding.subject !== identity.subject)
      throw new ConnectError("Execution not found", Code.NotFound);
    const graph = await projection.graphOf({ taskId: root.id });
    if (!graph) throw new ConnectError("Execution history is unavailable", Code.Unavailable);
    const tree = taskTree(graph, root.id);
    if (!tree) throw new ConnectError("Execution history is unavailable", Code.Unavailable);
    const latest = tree.latest;
    const execution = create(InvokeSessionOutputSchema, {
      sessionId: session.id,
      contextId: session.id,
      taskId: root.id,
      state: busy(tree) ? TaskState.WORKING : outcomeState(tree),
      text: latest.answer.slice(0, 4000),
    });
    return { root, session, graph, tree, execution };
  }
  return createMcpHandler(() => {
    const server = new McpServer({ name: "executions", version: "1.0.0" });
    server.registerTool(
      "run_execution",
      {
        description:
          "Run work with an authorized Agent. Reuse the request UUID and identical inputs for retries. Returns native task acceptance; the caller owns scheduling and deadlines.",
        inputSchema: inputSchema(runSchema),
        annotations: { idempotentHint: true },
      },
      async (args) => {
        const request = fromJson(RunExecutionRequestSchema, args);
        if (validator.validate(RunExecutionRequestSchema, request).kind !== "valid")
          throw new ConnectError(
            "Execution reference and message are required",
            Code.InvalidArgument,
          );
        const { ref, messageId } = reference(request.execution);
        const session = await admitted(ref);
        await registry.resolve(session);
        await projection.apply([], [sessionInfo(session)]);
        const task = await projection.send(
          agentKey(session.agent),
          create(MessageSchema, {
            contextId: session.id,
            messageId,
            role: Role.USER,
            parts: [{ content: { case: "text", value: request.message } }],
          }),
        );
        return result(
          InvokeSessionOutputSchema,
          create(InvokeSessionOutputSchema, {
            sessionId: session.id,
            contextId: task.contextId,
            taskId: task.id,
            state: task.status?.state ?? TaskState.WORKING,
            text: taskOutput(task).answer.slice(0, 4000),
          }),
        );
      },
    );
    server.registerTool(
      "get_execution",
      {
        description:
          "Read the native result of this caller's execution and its causal child tasks, with bounded, redacted result pages.",
        inputSchema: inputSchema(getSchema),
        annotations: { readOnlyHint: true },
      },
      async (args, context) => {
        const request = fromJson(GetExecutionRequestSchema, args);
        const current = await observed(request.execution);
        return result(
          GetExecutionResponseSchema,
          await executionResult(
            projection,
            current.graph,
            current.root.id,
            current.execution,
            request,
            context.mcpReq.signal,
          ),
        );
      },
    );
    server.registerTool(
      "cancel_execution",
      {
        description:
          "Revoke execution authority and cancel unfinished native work for this caller's execution, including delegated tasks.",
        inputSchema: inputSchema(referenceSchema),
        annotations: { idempotentHint: true },
      },
      async (args, context) => {
        const { ref } = reference(fromJson(ExecutionReferenceSchema, args));
        const session = await admitted(ref);
        await registry.revoke(session, identity);
        await refreshSession(projection, clients, session.id, context.mcpReq.signal);
        let current: Awaited<ReturnType<typeof observed>>;
        try {
          current = await observed(ref);
        } catch (error) {
          if (!(error instanceof ConnectError) || error.code !== Code.NotFound) throw error;
          return result(
            InvokeSessionOutputSchema,
            create(InvokeSessionOutputSchema, {
              sessionId: session.id,
              contextId: session.id,
              state: TaskState.CANCELED,
            }),
          );
        }
        await relatedExecutions(
          registry,
          clients.sessions,
          current.session,
          current.tree.entries.map((entry) => entry.contextId),
          true,
        );
        await cancelTree(clients, projection, current.tree, context.mcpReq.signal);
        return result(InvokeSessionOutputSchema, (await observed(ref)).execution);
      },
    );
    return server;
  });
}
