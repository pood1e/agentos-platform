import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { expect, it } from "vitest";
import { TaskStoreService } from "../gen/kagent/api/v1alpha1/task_store_pb.js";
import { grpcServer } from "../server/platform/grpc.js";

it("finishes an accepted persistence RPC while draining its HTTP/2 connection", async () => {
  let accept = () => {},
    finish = () => {};
  const received = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const result = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = grpcServer({
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
  const closed = server.close();
  finish();
  await expect(response).resolves.toMatchObject({
    stored: { version: 7n, task: { id: "saved" } },
  });
  await closed;
});
