import { create, fromJson } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it, onTestFinished } from "vitest";
import { TaskSchema } from "../gen/a2a_pb.js";
import { GetExecutionRequestSchema } from "../gen/agentos/execution/v1/service_pb.js";
import { InvokeSessionOutputSchema } from "../gen/kagent/api/v1/collaboration_pb.js";
import { executionResult } from "../server/execution/results.js";
import { fixtureState, fixtureIds as ids } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

it("redacts credentials repeated across tool arguments, task output and the execution summary", async () => {
  const secret = "credential-visible-in-output";
  const task = fromJson(TaskSchema, {
    id: "redacted-task",
    contextId: ids.chatContext,
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [
      {
        artifactId: "call",
        parts: [
          {
            data: { id: "call-1", name: "probe", args: { token: secret } },
            metadata: { "kagent.dev/a2a/part-type": "function_call" },
          },
        ],
      },
    ],
  });
  const graph = fixtureState([task]).graph();
  const entry = graph.entry(task.id);
  if (!entry) throw new Error("Missing native task");
  entry.answer = `Result: ${secret}`;
  const output = create(InvokeSessionOutputSchema, { taskId: task.id, text: secret });
  const response = await executionResult(
    { fullTask: async () => task },
    graph,
    task.id,
    output,
    create(GetExecutionRequestSchema),
  );
  expect(response.runs[0]?.calls).toHaveLength(1);
  expect(JSON.stringify(response)).not.toContain(secret);
  expect(response.execution?.text).toBe("[REDACTED]");
  expect(response.runs[0]?.output).toBe("Result: [REDACTED]");
});

it("paginates causal child tasks and fails closed for an invalid cursor or missing history", async () => {
  const f = await environment();
  onTestFinished(() => f.close());
  const graph = await f.projection.graphOf({ taskId: ids.approvalRoot });
  if (!graph) throw new Error("Missing execution graph");
  const request = create(GetExecutionRequestSchema, { page: { limit: 1 } });
  const output = create(InvokeSessionOutputSchema, { taskId: ids.approvalRoot });
  const first = await executionResult(f.projection, graph, ids.approvalRoot, output, request);
  expect(first.runs).toHaveLength(1);
  expect(first.page?.nextPageToken).toBeTruthy();
  request.page = {
    $typeName: "kagent.api.v1.PageRequest",
    limit: 1,
    pageToken: first.page?.nextPageToken ?? "",
  };
  const second = await executionResult(f.projection, graph, ids.approvalRoot, output, request);
  expect(second.runs).toHaveLength(1);
  expect(second.runs[0]?.taskId).not.toBe(first.runs[0]?.taskId);
  request.page.pageToken = "foreign-task";
  await expect(
    executionResult(f.projection, graph, ids.approvalRoot, output, request),
  ).rejects.toMatchObject({ code: Code.InvalidArgument });
  request.page.pageToken = "";
  await expect(
    executionResult({ fullTask: async () => undefined }, graph, ids.approvalRoot, output, request),
  ).rejects.toMatchObject({ code: Code.Unavailable });
});
