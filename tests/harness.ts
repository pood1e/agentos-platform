import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import { inject } from "vitest";
import type { Task } from "../gen/a2a_pb.js";
import {
  type UserIdentity,
  UserIdentitySchema,
} from "../gen/agentos/authorization/v1/identity_pb.js";
import { ConsoleService } from "../gen/agentos/console/v1/console_service_pb.js";
import { type ConsoleDependencies, consoleService } from "../server/console/service.js";
import type { AccessPlan } from "../server/governance/access-plans.js";
import { serverTargets, type Target, ToolBindings } from "../server/governance/bindings.js";
import { kagentClients } from "../server/kagent/clients.js";
import { nativeCredentials } from "../server/kagent/context.js";
import { workspaceContext } from "../server/platform/access.js";
import { taskQueries } from "../server/read-model/queries.js";
import { allCapabilities } from "../shared/permissions.js";
import { FakeKagent } from "./fake-kagent/kagent.js";
import { kagentRoutes } from "./fake-kagent/routes.js";
import { fixtureAgents, fixtureSessions, fixtureTasks } from "./fixtures/kagent.js";

/** The console user that recorded fixtures belong to. */
export const operator = create(UserIdentitySchema, {
  subject: "user:operator",
  write: true,
  capabilities: allCapabilities,
});

/** Fake kagent with recorded fixtures, for tests that never read the projection. */
export function fakeKagent(tasks: Task[] = fixtureTasks()) {
  const fake = new FakeKagent({ agents: fixtureAgents(), sessions: fixtureSessions(), tasks });
  return {
    fake,
    clients: kagentClients(
      createRouterTransport(kagentRoutes(fake), {
        transport: { interceptors: [nativeCredentials] },
      }),
    ),
  };
}

export async function environment(tasks: Task[] = fixtureTasks()) {
  const { fake, clients } = fakeKagent(tasks);
  const projection = taskQueries({ workspace: "agentos", clients });
  return {
    fake,
    clients,
    projection,
    async close() {},
  };
}

export const fixturePlans = () => JSON.parse(inject("accessPlans")) as AccessPlan[];

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
  identity: () => UserIdentity = () => operator,
) {
  const service = consoleService({
    projection: env.projection,
    clients: env.clients,
    namespace: "agentos",
    access: testBindings(env.fake),
    roleDefaults: { modelConfig: "default-model-config", harness: "standard" },
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
