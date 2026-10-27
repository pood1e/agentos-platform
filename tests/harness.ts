import { readFileSync } from "node:fs";
import { createRouterTransport } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import type { Task } from "../gen/a2a_pb.js";
import type { AccessPlan } from "../server/governance/access-plans.js";
import { serverTargets, type Target, ToolBindings } from "../server/governance/bindings.js";
import { kagentClients } from "../server/kagent/clients.js";
import { TaskIndex } from "../server/read-model/index.js";
import { KagentSync } from "../server/read-model/sync.js";
import { FakeKagent } from "./fake-kagent/kagent.js";
import { kagentRoutes } from "./fake-kagent/routes.js";
import { fixtureAgents, fixtureSessions, fixtureTasks } from "./fixtures/kagent.js";
import { memoryTaskTags } from "./fixtures/task-tags.js";

const noop = () => {};
export const silent = {
  level: "silent",
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  fatal: noop,
  trace: noop,
  silent: noop,
  child: () => silent,
} as unknown as FastifyBaseLogger;

export function environment(tasks: Task[] = fixtureTasks()) {
  const fake = new FakeKagent({ agents: fixtureAgents(), sessions: fixtureSessions(), tasks });
  const clients = kagentClients(createRouterTransport(kagentRoutes(fake)));
  const sync = new KagentSync(clients, "agentos", new TaskIndex(), silent);
  return { fake, clients, sync, index: sync.index, tags: memoryTaskTags() };
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
