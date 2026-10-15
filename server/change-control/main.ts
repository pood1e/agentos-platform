import { readFileSync } from "node:fs";
import { createServer } from "node:http2";
import { fromJsonString } from "@bufbuild/protobuf";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import Fastify, { LogController } from "fastify";
import { ExtMcp } from "../../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import {
  ChangeControlService,
  EnvironmentSchema,
  Governance,
} from "../../gen/agentos/governance/v1/change_pb.js";
import { loadCatalog } from "../operations/catalog.js";
import { listenConfig } from "../shared/config.js";
import { changeGuardrails } from "./ext-mcp.js";
import { Zammad } from "./providers/zammad/api.js";
import { ZammadApprovals } from "./providers/zammad/approvals.js";
import { changeControl } from "./service.js";
import { ChangeStore } from "./store.js";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const root = process.env.AGENTOS_CHANGE_CONFIG ?? "/etc/agentos/change";
const read = (name: string) => readFileSync(`${root}/${name}`, "utf8").trim();
const environment = fromJsonString(EnvironmentSchema, read("environment.json"));
const approverRole = Number(read("approver-role"));
if (
  !environment.name ||
  !environment.approvalUrl ||
  environment.governance !== Governance.APPROVAL ||
  !Number.isSafeInteger(approverRole) ||
  approverRole <= 0
)
  throw new Error("A valid environment and approval role are required");
const store = new ChangeStore(required("DATABASE_URL"));
await store.initialize();
const api = new Zammad(required("ZAMMAD_URL"), read("coordinator-token"));
const approvals = new ZammadApprovals(api, approverRole, environment.approvalUrl);
const control = changeControl(
  store,
  approvals,
  environment,
  loadCatalog(`${root}/toolsets.yaml`, `${root}/platform-tools.yaml`),
);
const app = Fastify({
  logger: true,
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 2 * 1024 * 1024,
});
await app.register(fastifyConnectPlugin, {
  interceptors: [createValidateInterceptor()],
  routes: (router) => router.service(ChangeControlService, control.rpc),
});
const processor = createServer(
  connectNodeAdapter({ routes: (router) => router.service(ExtMcp, changeGuardrails(control)) }),
);
app.get("/healthz", async () => ({ status: "ok" }));
app.get("/readyz", async () => ({ status: "ready" }));
app.addHook("onClose", async () => {
  await new Promise<void>((resolve) => processor.close(() => resolve()));
  await store.close();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close());
const { host } = listenConfig();
processor.listen(9090, host);
await app.listen(listenConfig());
