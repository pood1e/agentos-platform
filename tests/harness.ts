import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import type { Task } from "../gen/a2a_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { PackSchema } from "../gen/agentos/console/v1/pack_pb.js";
import {
  ExecutionBindingSchema,
  type ExecutionIdentity,
  ExecutionIdentitySchema,
} from "../gen/agentos/execution/v1/identity_pb.js";
import { executions } from "../server/authorization/executions.js";
import type { ExecutionStore } from "../server/authorization/store.js";
import { type ConsoleDependencies, consoleService } from "../server/console/service.js";
import type { AccessPlan } from "../server/governance/access-plans.js";
import { serverTargets, type Target, ToolBindings } from "../server/governance/bindings.js";
import { kagentClients } from "../server/kagent/clients.js";
import { workspaceContext } from "../server/platform/access.js";
import { agentRef } from "../server/read-model/agents.js";
import { ingest } from "../server/read-model/entry.js";
import { taskQueries } from "../server/read-model/queries.js";
import { allCapabilities } from "../shared/permissions.js";
import { FakeKagent } from "./fake-kagent/kagent.js";
import { kagentRoutes } from "./fake-kagent/routes.js";
import { memoryStore } from "./fixtures/execution-store.js";
import { fixtureAgents, fixtureSessions, fixtureTasks } from "./fixtures/kagent.js";

/** The console user that recorded fixtures belong to. */
export const operator = create(ExecutionIdentitySchema, {
  subject: "user:operator",
  write: true,
  capabilities: allCapabilities,
  credential: { case: "service", value: true },
});

/** Binds native sessions as the collaboration MCP would: delegated sessions join their caller's tree. */
export async function bindTasks(
  store: Pick<ExecutionStore, "saveBinding" | "binding">,
  fake: FakeKagent,
  tasks: Task[],
  subject = operator.subject,
) {
  const parents = new Map<string, string>();
  for (const task of tasks)
    for (const call of ingest(task, fake.tenantOf(task)).calls) {
      const child = call.delegation?.sessionId;
      if (child && child !== task.contextId && !parents.has(child))
        parents.set(child, task.contextId);
    }
  const root = (id: string) => {
    const seen = new Set<string>();
    while (parents.has(id) && !seen.has(id)) {
      seen.add(id);
      id = parents.get(id) ?? id;
    }
    return id;
  };
  const agents = new Map(tasks.map((task) => [task.contextId, fake.tenantOf(task)]));
  for (const session of fake.sessions.values())
    agents.set(session.id, `${session.agent?.namespace}/${session.agent?.name}`);
  for (const [sessionId, agent] of agents) {
    if (!agent || (await store.binding(sessionId))) continue;
    await store.saveBinding(
      create(ExecutionBindingSchema, {
        sessionId,
        agent: agentRef(agent),
        subject,
        rootSessionId: root(sessionId),
        parentSessionId: parents.get(sessionId) ?? "",
        write: true,
        capabilities: allCapabilities,
      }),
    );
  }
}

/** Fake kagent with recorded fixtures, for tests that never read the projection. */
export function fakeKagent(tasks: Task[] = fixtureTasks()) {
  const fake = new FakeKagent({ agents: fixtureAgents(), sessions: fixtureSessions(), tasks });
  return { fake, clients: kagentClients(createRouterTransport(kagentRoutes(fake))) };
}

export async function environment(tasks: Task[] = fixtureTasks()) {
  const { fake, clients } = fakeKagent(tasks);
  const store = memoryStore();
  await store.saveIdentity(operator);
  await bindTasks(store, fake, tasks);
  const projection = taskQueries({ workspace: "agentos", clients, executions: store });
  return {
    fake,
    clients,
    store,
    executions: executions(store),
    projection,
    async close() {},
  };
}

export async function until(check: () => boolean | Promise<boolean>, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const fixturePlans = () =>
  JSON.parse(
    readFileSync(new URL("../gen/test-access-plans.json", import.meta.url), "utf8"),
  ) as AccessPlan[];

/** Native credential isolation and execution requirements in the fake workspace. */
export function testBindings(fake: FakeKagent) {
  return async () =>
    new ToolBindings(serverTargets(fake.resources.list("accessplans") as unknown as AccessPlan[]));
}

export function publishTargets(fake: FakeKagent, targets: Target[]) {
  const plan = fake.resources.get("accessplans", "fixture");
  const value = plan as unknown as AccessPlan;
  value.status ??= {};
  const compiled = new Map(value.status.targets?.map((target) => [target.server, target]));
  for (const target of targets) compiled.set(target.server, target);
  value.status.targets = [...compiled.values()];
  fake.resources.save("accessplans", plan, false);
}

export type Environment = Awaited<ReturnType<typeof environment>>;

/** Console API over the environment, called by the given identity. */
export function consoleClient(
  env: Environment,
  overrides: Partial<ConsoleDependencies> = {},
  identity: () => ExecutionIdentity = () => operator,
) {
  const service = consoleService({
    projection: env.projection,
    clients: env.clients,
    executions: env.executions,
    namespace: "agentos",
    access: testBindings(env.fake),
    roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
    replaceTemplate: async (template) => env.fake.replaceTemplate(template),
    pack: create(PackSchema),
    ...overrides,
  });
  return createClient(
    ConsoleService,
    createRouterTransport((router) => router.service(ConsoleService, service), {
      router: {
        interceptors: [
          workspaceContext("agentos", "assistant", async () => identity()),
          createValidateInterceptor(),
        ],
      },
    }),
  );
}
