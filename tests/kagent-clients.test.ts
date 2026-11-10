import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { A2AService, TaskSchema } from "../gen/a2a_pb.js";
import { SystemService } from "../gen/kagent/api/v1/system_pb.js";
import { a2aVersion, kagentClients } from "../server/kagent/clients.js";

it("declares A2A 1.0 on A2A calls only", async () => {
  const versions = new Map<string, string | null>();
  const clients = kagentClients(
    createRouterTransport(
      (router) => {
        router.service(A2AService, {
          getTask(_request, context) {
            versions.set("a2a", context.requestHeader.get("a2a-version"));
            return create(TaskSchema, { id: "task" });
          },
        });
        router.service(SystemService, {
          getCurrentUser(_request, context) {
            versions.set("system", context.requestHeader.get("a2a-version"));
            return {};
          },
        });
      },
      { transport: { interceptors: [a2aVersion] } },
    ),
  );

  await clients.a2a.getTask({ id: "task" });
  await clients.system.getCurrentUser({});

  expect(versions).toEqual(
    new Map([
      ["a2a", "1.0"],
      ["system", null],
    ]),
  );
});
