import { createServer, type ServerHttp2Session } from "node:http2";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { expect, it } from "vitest";
import { A2AService } from "../gen/a2a_pb.js";
import { ResourceMetadataSchema } from "../gen/ateapi_pb.js";
import { MemoryService } from "../gen/kagent/api/v1alpha1/memory_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1alpha1/sessions_pb.js";
import { TaskStoreService } from "../gen/kagent/api/v1alpha1/task_store_pb.js";
import { registerRuntime } from "../server/authorization/native.js";
import type { ExecutionRuntime } from "../server/authorization/runtime.js";
import { environment } from "./harness.js";

it("exposes only native persistence RPCs, derives workload identity and denies foreign contexts before forwarding", async () => {
  const received: Headers[] = [],
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
            received.push(c.requestHeader);
            return {};
          },
          addSession: (_r, c) => {
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
  let revoked = false;
  const runtime = {
    authenticatedActor: async (headers: Headers) => {
      if (headers.get("x-substrate-actor-token") !== "Bearer host-signed")
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
        return { write: false };
      },
    },
  } as unknown as ExecutionRuntime;
  const { clients, sync } = environment([]);
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
    ),
  );
  const tasks = createClient(TaskStoreService, transport),
    memory = createClient(MemoryService, transport);
  const headers = {
    "x-substrate-actor-token": "Bearer host-signed",
    "x-kagent-insecure-runtime-identity": "workspace/victim/forged",
  };
  try {
    await tasks.createTask(
      { sessionId: "own", task: { id: "task", contextId: "own" } },
      { headers },
    );
    expect(received).toHaveLength(1);
    expect(received[0].get("x-kagent-insecure-runtime-identity")).toBe(
      "workspace/session-own/current-uid",
    );
    expect(received[0].get("x-user-id")).toBe("server-user");
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
      memory.addSession(
        { memory: { agentName: "workspace/assistant", userId: "admin" } },
        { headers },
      ),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(
      memory.search({ agentName: "other/assistant", userId: "admin" }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(received).toHaveLength(1);
    await memory.search({ agentName: "workspace/assistant", userId: "admin" }, { headers });
    expect(received).toHaveLength(2);
    revoked = true;
    await expect(
      tasks.createTask({ sessionId: "own", task: { id: "next", contextId: "own" } }, { headers }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await tasks.getTask({ sessionId: "own", taskId: "task" }, { headers });
    expect(received).toHaveLength(3);
  } finally {
    sync.close();
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
