import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { TaskStoreService } from "../gen/kagent/api/v1alpha1/task_store_pb.js";
import { grpcServer } from "../server/platform/grpc.js";

it("finishes an accepted persistence RPC while draining its HTTP/2 connection", async () => {
  const app = Fastify();
  let accept = () => {},
    finish = () => {};
  const received = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const result = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = grpcServer(app, {
    routes: (router) =>
      router.service(TaskStoreService, {
        getTask: async () => {
          accept();
          await result;
          return { stored: { version: 7n, task: { id: "saved" } } };
        },
      }),
  });
  await server.listen(0, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("RPC address missing");
  const client = createClient(
    TaskStoreService,
    createGrpcTransport({ baseUrl: `http://127.0.0.1:${address.port}` }),
  );
  const response = client.getTask({ sessionId: "session", taskId: "saved" });
  await received;
  const closed = app.close();
  finish();
  await expect(response).resolves.toMatchObject({
    stored: { version: 7n, task: { id: "saved" } },
  });
  await closed;
});

it("drains RPCs before waiting for an open HTTP chat stream", async () => {
  const app = Fastify();
  let accept = () => {},
    finish = () => {},
    endWatch = () => {};
  const received = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const result = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = grpcServer(app, {
    routes: (router) =>
      router.service(TaskStoreService, {
        getTask: async () => {
          accept();
          await result;
          return { stored: { version: 9n, task: { id: "saved" } } };
        },
      }),
  });
  app.get("/watch", (_request, reply) => {
    reply.hijack();
    reply.raw.write("open\n");
    endWatch = () => reply.raw.end("done\n");
  });
  await server.listen(0, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("RPC address missing");
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const watcher = await fetch(`${url}/watch`);
  const client = createClient(
    TaskStoreService,
    createGrpcTransport({ baseUrl: `http://127.0.0.1:${address.port}` }),
  );
  const response = client.getTask({ sessionId: "session", taskId: "saved" });
  await received;
  let httpClosed = false;
  const closed = app.close().then(() => {
    httpClosed = true;
  });
  try {
    finish();
    await expect(response).resolves.toMatchObject({ stored: { version: 9n } });
    expect(httpClosed).toBe(false);
    expect(server.address()).toBeNull();
  } finally {
    endWatch();
    await watcher.text();
    await closed;
  }
});
