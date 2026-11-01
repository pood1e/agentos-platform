import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { TaskCatalogService } from "../gen/kagent/api/v1/task_catalog_pb.js";
import { nativeCredentials } from "../server/kagent/context.js";
import { consoleClient, environment } from "./harness.js";

const agent = { namespace: "agentos", name: "assistant" };
const reads = {
  conversations: (
    client: ReturnType<typeof consoleClient>,
    signal: AbortSignal | undefined,
    caller: string,
  ) =>
    client.listConversations({ agent }, { signal, headers: { authorization: `Bearer ${caller}` } }),
  tasks: (
    client: ReturnType<typeof consoleClient>,
    signal: AbortSignal | undefined,
    caller: string,
  ) => client.listTasks({}, { signal, headers: { authorization: `Bearer ${caller}` } }),
  engineers: (
    client: ReturnType<typeof consoleClient>,
    signal: AbortSignal | undefined,
    caller: string,
  ) => client.listEngineers({}, { signal, headers: { authorization: `Bearer ${caller}` } }),
  runs: (
    client: ReturnType<typeof consoleClient>,
    signal: AbortSignal | undefined,
    caller: string,
  ) =>
    client.listEngineerRuns(
      { engineer: "agentos/inspection" },
      { signal, headers: { authorization: `Bearer ${caller}` } },
    ),
};
afterEach(() => vi.restoreAllMocks());

async function intercepted(phase: "query" | "payload") {
  const env = await environment(),
    original = env.clients.catalog;
  const signals: AbortSignal[] = [],
    healthySignals: AbortSignal[] = [],
    writes: string[] = [];
  let releaseHealthy = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseHealthy = resolve;
  });
  const pause = async (signal: AbortSignal, caller: string | null) => {
    if (caller === "Bearer canceled-reader") {
      signals.push(signal);
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      throw new ConnectError("Read canceled", Code.Canceled);
    }
    if (caller === "Bearer healthy-reader") {
      healthySignals.push(signal);
      await gate;
      if (signal.aborted) throw new ConnectError("Read canceled", Code.Canceled);
    }
  };
  env.clients.catalog = createClient(
    TaskCatalogService,
    createRouterTransport(
      (router) => {
        router.service(TaskCatalogService, {
          async listSessionActivity(request, context) {
            if (phase === "query")
              await pause(context.signal, context.requestHeader.get("authorization"));
            const result = await original.listSessionActivity(request, { signal: context.signal });
            if (phase === "payload")
              await pause(context.signal, context.requestHeader.get("authorization"));
            return result;
          },
          async listTaskGroups(request, context) {
            if (phase === "query")
              await pause(context.signal, context.requestHeader.get("authorization"));
            const result = await original.listTaskGroups(request, { signal: context.signal });
            if (phase === "payload")
              await pause(context.signal, context.requestHeader.get("authorization"));
            return result;
          },
          async listAgentActivity(request, context) {
            if (phase === "query")
              await pause(context.signal, context.requestHeader.get("authorization"));
            const result = await original.listAgentActivity(request, { signal: context.signal });
            if (phase === "payload")
              await pause(context.signal, context.requestHeader.get("authorization"));
            return result;
          },
          async listTaskRecords(request, context) {
            if (phase === "query")
              await pause(context.signal, context.requestHeader.get("authorization"));
            const result = await original.listTaskRecords(request, { signal: context.signal });
            if (phase === "payload")
              await pause(context.signal, context.requestHeader.get("authorization"));
            return result;
          },
        });
      },
      {
        transport: {
          interceptors: [
            nativeCredentials,
            (next) => (request) => {
              if (!request.method.name.startsWith("List")) writes.push(request.method.name);
              return next(request);
            },
          ],
        },
      },
    ),
  );
  return { ...env, signals, healthySignals, releaseHealthy, writes };
}

for (const phase of ["query", "payload"] as const)
  it.each(Object.keys(reads) as (keyof typeof reads)[])(
    `cancels native catalog ${phase} for %s without canceling another reader or background work`,
    async (method) => {
      const env = await intercepted(phase),
        client = consoleClient(env),
        controller = new AbortController();
      const cancellation = reads[method](client, controller.signal, "canceled-reader").catch(
        (error) => error,
      );
      const cancelTask = vi.spyOn(env.clients.a2a, "cancelTask"),
        remove = vi.spyOn(env.clients.sessions, "deleteSession");
      const send = vi.spyOn(env.clients.a2a, "sendMessage");
      try {
        await vi.waitFor(() => expect(env.signals.length).toBeGreaterThan(0));
        const healthy = reads[method](client, undefined, "healthy-reader");
        await vi.waitFor(() => expect(env.healthySignals.length).toBeGreaterThan(0));
        controller.abort();
        expect(await cancellation).toMatchObject({ code: Code.Canceled });
        await vi.waitFor(() => expect(env.signals.every((signal) => signal.aborted)).toBe(true));
        expect(env.healthySignals.every((signal) => !signal.aborted)).toBe(true);
        env.releaseHealthy();
        const result = await healthy;
        expect(await reads[method](client, undefined, "healthy-reader")).toEqual(result);
        expect(env.writes).toEqual([]);
        expect(env.fake.received).toEqual([]);
        expect(cancelTask).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        env.releaseHealthy();
        await cancellation;
      }
    },
  );
