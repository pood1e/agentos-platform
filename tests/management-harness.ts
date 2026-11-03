import { createServer } from "node:http";
import { CoreV1Api, CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import { resourceStore } from "../server/management/resources.js";
import { managementService } from "../server/management/service.js";
import { workflowDocuments } from "../server/management/workflows/documents.js";
import { speechSettingsStore } from "../server/voice/settings.js";
import { kubernetesRequest } from "./fake-kagent/kubernetes.js";
import { fakeKagent, testBindings } from "./harness.js";

export async function managementEnvironment() {
  const env = fakeKagent();
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
  const store = resourceStore(config, "agentos", "agentos-skills", env.clients);
  const dependencies = {
    access: testBindings(env.fake),
    documents: workflowDocuments(
      config.makeApiClient(CoreV1Api),
      config.makeApiClient(CustomObjectsApi),
      "agentos",
    ),
    speech: speechSettingsStore(config.makeApiClient(CoreV1Api), "agentos", "agentos-speech"),
    store,
    clients: env.clients,
    namespace: "agentos",
    gatewayName: "agentos-gateway",
    knowledgeTtlDays: 3650,
  };
  return {
    ...env,
    url,
    store,
    kubeConfig: config,
    dependencies,
    service: managementService(dependencies),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
