import { createServer, type ServerHttp2Session } from "node:http2";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { expect, it } from "vitest";
import { A2AService } from "../gen/a2a_pb.js";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { ResourceMetadataSchema } from "../gen/ateapi_pb.js";
import { AgentSchema } from "../gen/kagent/api/v1/agents_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { MemoryService } from "../gen/kagent/runtime/v1/memory_pb.js";
import { TaskStoreService } from "../gen/kagent/runtime/v1/task_store_pb.js";
import { registerRuntime } from "../server/authorization/native.js";
import type { ExecutionRuntime } from "../server/authorization/runtime.js";
import { fakeKagent } from "./harness.js";

it("exposes only native persistence RPCs, derives workload identity and denies foreign contexts before forwarding", async () => {
  const received: Headers[] = [],
    memoryOwners: string[] = [],
    connections = new Set<ServerHttp2Session>();
  const server = createServer(
    connectNodeAdapter({
      routes: (router) => {
        router.service(TaskStoreService, {
          createTask: (_r, c) => {
            received.push(c.requestHeader);
            return { version: 1n };
          },
          getTask: (_r, c) => {
            received.push(c.requestHeader);
            return {};
          },
          listTasks: (_r, c) => {
            received.push(c.requestHeader);
            return {};
          },
        });
        router.service(MemoryService, {
          search: (_r, c) => {
            memoryOwners.push(c.requestHeader.get("x-user-id") ?? "");
            received.push(c.requestHeader);
            return {};
          },
          addSession: (_r, c) => {
            memoryOwners.push(c.requestHeader.get("x-user-id") ?? "");
            received.push(c.requestHeader);
            return {};
          },
        });
      },
    }),
  );
  server.on("session", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Upstream missing");
  const session = create(SessionSchema, {
    id: "own",
    creator: "server-user",
    agent: { namespace: "workspace", name: "assistant" },
  });
  let revoked = false,
    subject = "user:alice";
  let capabilities: Capability[] = [];
  const runtime = {
    authenticatedActor: async (headers: Headers) => {
      if (headers.get("authorization") !== "Bearer host-signed")
        throw new ConnectError("Invalid actor", Code.Unauthenticated);
      return {
        session,
        actor: create(ResourceMetadataSchema, {
          atespace: "workspace",
          name: "session-own",
          uid: "current-uid",
        }),
      };
    },
    registry: {
      record: async (_session: unknown, allowRevoked?: boolean) => {
        if (revoked && !allowRevoked) throw new ConnectError("Revoked", Code.PermissionDenied);
      },
      resolve: async () => {
        if (revoked) throw new ConnectError("Revoked", Code.PermissionDenied);
        return { write: false, capabilities, identity: { subject } };
      },
    },
  } as unknown as ExecutionRuntime;
  const { fake, clients } = fakeKagent([]);
  const agent = create(AgentSchema, {
    ref: session.agent,
    resource: { kind: "Agent", value: { spec: { harnessRef: { name: "standard" } } } },
  });
  fake.agents.push(agent);
  const transport = createRouterTransport((router) =>
    registerRuntime(
      router,
      runtime,
      {
        url: `http://127.0.0.1:${address.port}`,
        namespace: "workspace",
        userId: "console",
      },
      clients,
      { agentName: "workspace/knowledge", userId: "team-knowledge" },
    ),
  );
  const tasks = createClient(TaskStoreService, transport),
    memory = createClient(MemoryService, transport);
  const headers = {
    authorization: "Bearer host-signed",
    "x-kagent-insecure-runtime-identity": "workspace/victim/forged",
  };
  try {
    await tasks.createTask(
      { sessionId: "own", task: { id: "task", contextId: "own" } },
      { headers },
    );
    expect(received).toHaveLength(1);
    expect(received[0].get("x-kagent-insecure-runtime-identity")).toBeNull();
    expect(received[0].get("x-user-id")).toBeNull();
    expect(received[0].get("authorization")).toBe("Bearer host-signed");
    await expect(
      tasks.getTask({ sessionId: "foreign", taskId: "task" }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(
      tasks.createTask(
        { sessionId: "own", task: { id: "task", contextId: "foreign" } },
        { headers },
      ),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(
      tasks.listTasks({ sessionId: "own", request: { contextId: "foreign" } }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(
      tasks.getTask(
        { sessionId: "own", taskId: "task" },
        { headers: { "x-kagent-insecure-runtime-identity": "workspace/session-own/current-uid" } },
      ),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(
      createClient(A2AService, transport).getTask({ id: "foreign" }, { headers }),
    ).rejects.toMatchObject({ code: Code.Unimplemented });
    await expect(
      memory.addSession({ managementAgent: "workspace/assistant", memory: {} }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(
      memory.search({ managementAgent: "other/assistant" }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(received).toHaveLength(1);
    await memory.search({ managementAgent: "workspace/assistant" }, { headers });
    expect(memoryOwners).toEqual(["user:alice"]);
    expect(received).toHaveLength(2);
    subject = "user:bob";
    await memory.search({ managementAgent: "workspace/assistant" }, { headers });
    await expect(
      memory.search({ managementAgent: "workspace/knowledge" }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(memoryOwners).toEqual(["user:alice", "user:bob"]);
    if (!agent.resource?.value) throw new Error("Fixture Agent missing");
    agent.resource.value.spec = { harnessRef: { name: "memory" } };
    await memory.addSession({ managementAgent: "workspace/assistant", memory: {} }, { headers });
    expect(memoryOwners.at(-1)).toBe("user:bob");
    if (!session.agent) throw new Error("Fixture Session missing Agent");
    session.agent.name = "knowledge";
    agent.ref = session.agent;
    await expect(
      memory.addSession({ managementAgent: "workspace/knowledge", memory: {} }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    capabilities = [Capability.KNOWLEDGE_MANAGE];
    await memory.addSession({ managementAgent: "workspace/knowledge", memory: {} }, { headers });
    expect(memoryOwners.at(-1)).toBe("team-knowledge");
    expect(received.at(-1)?.get("x-user-id")).toBe("team-knowledge");
    revoked = true;
    await expect(
      tasks.createTask({ sessionId: "own", task: { id: "next", contextId: "own" } }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await tasks.getTask({ sessionId: "own", taskId: "task" }, { headers });
    expect(received).toHaveLength(6);
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("reports lost upstream transport as Unavailable and keeps upstream status codes", async () => {
  const connections = new Set<ServerHttp2Session>();
  let conflict = false;
  const server = createServer(
    connectNodeAdapter({
      routes: (router) => {
        router.service(TaskStoreService, {
          updateTask: () => {
            if (conflict) throw new ConnectError("Version conflict", Code.Aborted);
            for (const connection of connections) connection.destroy();
            return new Promise<never>(() => {});
          },
        });
      },
    }),
  );
  server.on("session", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Upstream missing");
  const session = create(SessionSchema, {
    id: "own",
    agent: { namespace: "workspace", name: "assistant" },
  });
  let streamClosed = true;
  const runtime = {
    authenticatedActor: async () => ({ session }),
    registry: {
      record: async () => {
        if (!streamClosed) return;
        streamClosed = false;
        throw Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" });
      },
    },
  } as unknown as ExecutionRuntime;
  const { clients } = fakeKagent([]);
  const warnings: unknown[] = [];
  const tasks = createClient(
    TaskStoreService,
    createRouterTransport((router) =>
      registerRuntime(
        router,
        runtime,
        { url: `http://127.0.0.1:${address.port}`, namespace: "workspace", userId: "console" },
        clients,
        undefined,
        undefined,
        { warn: (entry: unknown) => warnings.push(entry) },
      ),
    ),
  );
  const update = { sessionId: "own", task: { id: "task", contextId: "own" } };
  try {
    await expect(tasks.updateTask(update)).rejects.toMatchObject({ code: Code.Unavailable });
    await expect(tasks.updateTask(update)).rejects.toMatchObject({ code: Code.Unavailable });
    expect(warnings).toHaveLength(2);
    conflict = true;
    await expect(tasks.updateTask(update)).rejects.toMatchObject({ code: Code.Aborted });
    expect(warnings).toHaveLength(2);
  } finally {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
