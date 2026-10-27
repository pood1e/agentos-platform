import { createServer } from "node:http";
import { clone } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { KubeConfig } from "@kubernetes/client-node";
import { expect, it } from "vitest";
import { ErrorInfoSchema } from "../gen/google/rpc/error_details_pb.js";
import { AgentTemplateSchema } from "../gen/kagent/api/v1/agent_templates_pb.js";
import { templateWriter } from "../server/console/template-writer.js";
import { kubernetesRequest } from "./fake-kagent/kubernetes.js";
import { fakeKagent } from "./harness.js";

it("atomically rejects a concurrent template replacement through the official Kubernetes SDK", async () => {
  const { fake } = fakeKagent();
  const server = createServer(async (request, response) => {
    if (!(await kubernetesRequest(fake, request, response))) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test API not listening");
  try {
    const config = new KubeConfig();
    config.loadFromOptions({
      clusters: [{ name: "test", server: `http://127.0.0.1:${address.port}`, skipTLSVerify: true }],
      users: [{ name: "test" }],
      contexts: [{ name: "test", cluster: "test", user: "test" }],
      currentContext: "test",
    });
    const replace = templateWriter(config);
    const first = clone(AgentTemplateSchema, fake.template("inspection"));
    const second = clone(AgentTemplateSchema, first);
    const results = await Promise.allSettled([replace(first), replace(second)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected" || !(rejected.reason instanceof ConnectError))
      throw new Error("expected a version conflict");
    expect(rejected.reason.code).toBe(Code.Aborted);
    expect(rejected.reason.findDetails(ErrorInfoSchema)[0]?.reason).toBe("configuration.conflict");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
