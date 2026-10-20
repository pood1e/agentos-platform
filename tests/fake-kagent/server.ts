import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:http2";
import { create, fromJson, fromJsonString } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { TaskSchema, TaskState, TaskStatusSchema } from "../../gen/a2a_pb.js";
import { ToolApprovalResponseSchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import { hitlPayload, hitlReply } from "../../server/read-model/decode/hitl.js";
import { fixtureExecutions } from "../fixtures/executions.js";
import { fixtureAgents, fixtureSessions } from "../fixtures/kagent.js";
import { templates } from "./catalog.js";
import { FakeKagent } from "./kagent.js";
import { kubernetesRequest } from "./kubernetes.js";
import { kagentRoutes } from "./routes.js";
import { pendingApprovalTasks, syntheticOperations } from "./scenario.js";

/** kagent gRPC endpoint backed by recorded tasks, for local development and browser tests. */
const initial = () => ({ sessions: fixtureSessions(), tasks: pendingApprovalTasks() });
const fake = new FakeKagent({ agents: fixtureAgents(), ...initial() });
const execution = await fixtureExecutions();
fake.executionCreated = execution.created;
await execution.seed([...fake.sessions.values()], true);
const port = Number(process.env.FAKE_KAGENT_PORT ?? "8083");
createServer(connectNodeAdapter({ routes: kagentRoutes(fake) })).listen(port, "127.0.0.1");

// Test control: restore the recorded state or add operations for paging.
const control = Number(process.env.FAKE_KAGENT_CONTROL_PORT ?? String(port + 1));
createHttpServer(async (request, response) => {
  if (await kubernetesRequest(fake, request, response)) return;
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/healthz") response.statusCode = 200;
  else if (request.method === "POST" && url.pathname === "/reset") {
    fake.load(initial());
    await execution.seed([...fake.sessions.values()], true);
    fake.agents.splice(0, fake.agents.length, ...fixtureAgents());
    fake.resources.reset();
    fake.memory.reset();
    fake.templates.clear();
    for (const template of templates()) fake.templates.set(template.ref?.name ?? "", template);
  } else if (request.method === "POST" && url.pathname === "/bind") {
    const sessions = url.searchParams.getAll("session").map((id) => {
      const session = fake.sessions.get(id);
      if (!session) throw new Error("Fixture session missing");
      return session;
    });
    await execution.seed(sessions);
  } else if (request.method === "POST" && url.pathname === "/seed") {
    const { sessions, tasks } = syntheticOperations(Number(url.searchParams.get("count") ?? "20"));
    fake.load({
      sessions: [...fake.sessions.values(), ...sessions],
      tasks: [...fake.tasks.values(), ...tasks],
    });
    await execution.seed(sessions);
  } else if (request.method === "GET" && url.pathname.startsWith("/orders/")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.write("<!doctype html><title>Test work order</title><h1>Work order #123</h1>");
  } else if (request.method === "POST" && url.pathname === "/decide") {
    const task = fake.task(url.searchParams.get("id") ?? "");
    const pending = hitlPayload(task.status?.message);
    if (pending?.type !== "tool_approval_request") response.statusCode = 409;
    else
      fake.accept(
        hitlReply(
          { taskId: task.id, contextId: task.contextId },
          randomUUID(),
          {
            type: "tool_approval_response",
            value: create(ToolApprovalResponseSchema, {
              approvals: (pending.value.nested?.tools ?? pending.value.tools).map((tool) => ({
                id: tool.id,
                approved: url.searchParams.get("approved") === "true",
                rejectionReason: url.searchParams.get("reason") ?? "",
              })),
            }),
          },
          "The environment work order has been decided.",
        ),
      );
  } else if (request.method === "POST" && url.pathname === "/state") {
    const status = fromJson(TaskStatusSchema, { state: url.searchParams.get("state") });
    fake.update(fake.task(url.searchParams.get("id") ?? ""), status.state);
  } else if (request.method === "POST" && url.pathname === "/observe") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const task = fromJsonString(TaskSchema, Buffer.concat(chunks).toString());
    fake.update(task, task.status?.state ?? TaskState.UNSPECIFIED, task.status?.message);
  } else response.statusCode = 404;
  response.end();
}).listen(control, "127.0.0.1", () => console.log(`fake kagent listening on ${port}`));
