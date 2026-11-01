import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { A2AService, TaskState } from "../gen/a2a_pb.js";
import { nativeCredentials } from "../server/kagent/context.js";
import { fixtureIds } from "./fixtures/kagent.js";
import { consoleClient, environment } from "./harness.js";

const agent = { namespace: "agentos", name: "assistant" };
const reads = {
  conversations: (client: ReturnType<typeof consoleClient>, signal?: AbortSignal) =>
    client.listConversations(
      { agent },
      { signal, headers: { authorization: "Bearer canceled-reader" } },
    ),
  tasks: (client: ReturnType<typeof consoleClient>, signal?: AbortSignal) =>
    client.listTasks({}, { signal, headers: { authorization: "Bearer canceled-reader" } }),
  engineers: (client: ReturnType<typeof consoleClient>, signal?: AbortSignal) =>
    client.listEngineers({}, { signal, headers: { authorization: "Bearer canceled-reader" } }),
  runs: (client: ReturnType<typeof consoleClient>, signal?: AbortSignal) =>
    client.listEngineerRuns(
      { engineer: "agentos/inspection" },
      { signal, headers: { authorization: "Bearer canceled-reader" } },
    ),
};
afterEach(() => vi.restoreAllMocks());

async function intercepted(phase: "catalog" | "hydration") {
  const env = await environment();
  const original = env.clients.a2a;
  if (phase === "hydration") env.fake.update(env.fake.task(fixtureIds.chatRoot), TaskState.WORKING);
  const signals: AbortSignal[] = [];
  const healthySignals: AbortSignal[] = [];
  let releaseHealthy = () => {};
  const healthyGate = new Promise<void>((resolve) => {
    releaseHealthy = resolve;
  });
  const pause = async (signal: AbortSignal, caller: string | null) => {
    if (caller === "Bearer canceled-reader") {
      signals.push(signal);
      await untilAborted(signal);
    } else if (caller === "Bearer healthy-reader") {
      healthySignals.push(signal);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new ConnectError("Read canceled", Code.Canceled));
        signal.addEventListener("abort", abort, { once: true });
        healthyGate.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
        if (signal.aborted) abort();
      });
    }
  };
  const writes: string[] = [];
  env.clients.a2a = createClient(
    A2AService,
    createRouterTransport(
      (router) => {
        router.service(A2AService, {
          async listTasks(request, context) {
            if (phase === "catalog")
              await pause(context.signal, context.requestHeader.get("authorization"));
            return original.listTasks(request, { signal: context.signal });
          },
          async getTask(request, context) {
            if (phase === "hydration")
              await pause(context.signal, context.requestHeader.get("authorization"));
            return original.getTask(request, { signal: context.signal });
          },
        });
      },
      {
        transport: {
          interceptors: [
            nativeCredentials,
            (next) => (request) => {
              if (!/^(Get|List)/.test(request.method.name)) writes.push(request.method.name);
              return next(request);
            },
          ],
        },
      },
    ),
  );
  return { ...env, signals, healthySignals, releaseHealthy, writes };
}

async function untilAborted(signal: AbortSignal) {
  if (!signal.aborted)
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  throw new ConnectError("Read canceled", Code.Canceled);
}

for (const phase of ["catalog", "hydration"] as const)
  it.each(Object.keys(reads) as (keyof typeof reads)[])(
    `cancels native ${phase} for %s without stopping another caller or background work`,
    async (method) => {
      const env = await intercepted(phase);
      const client = consoleClient(env);
      const controller = new AbortController();
      const failure = reads[method](client, controller.signal).catch((error: unknown) => error);
      const cancelTask = vi.spyOn(env.clients.a2a, "cancelTask");
      const deleteSession = vi.spyOn(env.clients.sessions, "deleteSession");
      try {
        await vi.waitFor(() => expect(env.signals.length).toBeGreaterThan(0));
        const pending = client
          .listConversations({ agent }, { headers: { authorization: "Bearer healthy-reader" } })
          .catch((error: unknown) => error);
        await vi.waitFor(() => expect(env.healthySignals.length).toBeGreaterThan(0));
        controller.abort();
        expect(await failure).toMatchObject({ code: Code.Canceled });
        await vi.waitFor(() => expect(env.signals.every((signal) => signal.aborted)).toBe(true));
        expect(env.healthySignals.every((signal) => !signal.aborted)).toBe(true);
        env.releaseHealthy();
        const healthy = await pending;
        expect(healthy).toHaveProperty("conversations");
        const after = await client.listConversations(
          { agent },
          { headers: { authorization: "Bearer healthy-reader" } },
        );
        expect(after).toEqual(healthy);
        expect(env.writes).toEqual([]);
        expect(cancelTask).not.toHaveBeenCalled();
        expect(deleteSession).not.toHaveBeenCalled();
        expect(env.fake.received).toEqual([]);
      } finally {
        controller.abort();
        env.releaseHealthy();
        await failure;
        await env.close();
      }
    },
  );
