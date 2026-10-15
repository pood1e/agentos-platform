import { createServer } from "node:http";
import { create } from "@bufbuild/protobuf";
import { KubeConfig } from "@kubernetes/client-node";
import { OperationsConfigSchema } from "../gen/agentos/governance/v1/change_pb.js";
import { resourceStore } from "../server/management/resources.js";
import { managementService } from "../server/management/service.js";
import { kubernetesRequest } from "./fake-kagent/kubernetes.js";
import { environment } from "./harness.js";

export async function managementEnvironment() {
  const env = environment();
  const server = createServer(async (request, response) => {
    if (!(await kubernetesRequest(env.fake, request, response))) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API not listening");
  const url = `http://127.0.0.1:${address.port}`;
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: "test", server: url, skipTLSVerify: true }],
    users: [{ name: "test" }],
    contexts: [{ name: "test", cluster: "test", user: "test" }],
    currentContext: "test",
  });
  const store = resourceStore(config, "agentos", "agentos-skills");
  const dependencies = {
    store,
    clients: env.clients,
    gateway: {
      url,
      mcpUrl: url,
      namespace: "agentos",
      name: "agentos-gateway",
      secret: "agentos-gateway",
    },
    knowledge: {
      url: `${url}/v1`,
      token: "test-gateway-token",
      model: "embeddinggemma:300m",
      scope: { agentName: "agentos__NS__knowledge", userId: "agentos", ttlDays: 3650 },
    },
    operations: create(OperationsConfigSchema),
  };
  return {
    ...env,
    store,
    dependencies,
    service: managementService(dependencies),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
