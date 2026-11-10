import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArtifactSchema, Role, type Task, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { CatalogTaskSchema, TaskCatalogView } from "../gen/kagent/api/v1/task_catalog_pb.js";
import { catalogRevision } from "../server/read-model/catalog-entries.js";
import { consoleClient, type Environment, environment } from "./harness.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, value: unknown, { signal }: { signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const timer = setTimeout(done, ms);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
}));

const agent = { namespace: "agentos", name: "inspection" };
const stopped = new Set<AbortController>();
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const controller of stopped) controller.abort();
  stopped.clear();
  vi.useRealTimers();
});

function conversationTask(env: Environment, id: string, contextId: string, state: TaskState) {
  const task = create(TaskSchema, {
    id,
    contextId,
    history: [
      {
        messageId: `${id}-question`,
        role: Role.USER,
        parts: [{ content: { case: "text", value: "Inspect" } }],
      },
    ],
  });
  env.fake.update(task, state);
  return task;
}

interface View {
  runs?: number;
  operate?: boolean;
  text?: string;
}
const texts = (views: View[]) => views.map((view) => view.text);

/** Follows a conversation in the background, as a browser tab does. */
function watching(env: Environment, contextId: string) {
  const controller = new AbortController();
  stopped.add(controller);
  const views: View[] = [];
  const failure = (async () => {
    for await (const { conversation } of consoleClient(env).watchConversation(
      { agent, contextId },
      { signal: controller.signal },
    ))
      views.push({
        runs: conversation?.runs.length,
        operate: conversation?.operate,
        text: conversation?.messages
          .at(-1)
          ?.parts.flatMap((part) =>
            part.content.case === "progress" || part.content.case === "text"
              ? [part.content.value]
              : [],
          )
          .at(-1),
      });
  })().catch((error: unknown) => error);
  return { views, failure };
}

const reads = (env: Environment, view: TaskCatalogView) =>
  env.fake.catalogReads.filter((read) => read.view === view).length;

async function settledConversation() {
  const env = await environment();
  const session = env.fake.createSession(agent, "settled-conversation", "Settled");
  const task = conversationTask(env, "settled-task", session.id, TaskState.COMPLETED);
  return { env, session, task };
}

it("polls the indexed summary while a conversation stays settled", async () => {
  const { env, session } = await settledConversation();
  const listAgents = vi.spyOn(env.clients.agents, "listAgents");
  watching(env, session.id);
  await vi.advanceTimersByTimeAsync(100);
  expect(reads(env, TaskCatalogView.DETAILS)).toBe(1);
  expect(env.fake.fetched).toEqual([]);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(reads(env, TaskCatalogView.DETAILS)).toBe(1);
  expect(reads(env, TaskCatalogView.SUMMARY)).toBeGreaterThanOrEqual(3);
  expect(env.fake.fetched).toEqual([]);
  expect(listAgents).toHaveBeenCalledOnce();
});

it("treats summary and detail time precision as the same revision", () => {
  const row = (nanos: number) => ({
    tasks: [
      create(CatalogTaskSchema, {
        task: {
          id: "task",
          status: { state: TaskState.COMPLETED, timestamp: { seconds: 5n, nanos } },
        },
      }),
    ],
    sessions: [],
  });
  expect(catalogRevision(row(123_000_000))).toBe(catalogRevision(row(123_456_789)));
});

it("refreshes Agent metadata of a settled conversation within the staleness bound", async () => {
  const { env, session } = await settledConversation();
  const listAgents = vi.spyOn(env.clients.agents, "listAgents");
  watching(env, session.id);
  await vi.advanceTimersByTimeAsync(32_000);
  expect(reads(env, TaskCatalogView.DETAILS)).toBe(2);
  expect(listAgents).toHaveBeenCalledTimes(2);
});

it("rebuilds at the next poll when the summary shows new work", async () => {
  const { env, session } = await settledConversation();
  const { views } = watching(env, session.id);
  await vi.advanceTimersByTimeAsync(100);
  expect(views.at(-1)?.runs).toBe(1);
  conversationTask(env, "follow-up-task", session.id, TaskState.COMPLETED);
  await vi.advanceTimersByTimeAsync(5_500);
  expect(reads(env, TaskCatalogView.DETAILS)).toBe(2);
  expect(views.at(-1)?.runs).toBe(2);
});

it("reflects revoked execution authority at the next poll", async () => {
  const { env, session } = await settledConversation();
  const { views } = watching(env, session.id);
  await vi.advanceTimersByTimeAsync(100);
  expect(views.at(-1)?.operate).toBe(true);
  env.fake.renewable = false;
  await vi.advanceTimersByTimeAsync(5_500);
  expect(views.at(-1)?.operate).toBe(false);
});

it("ends a settled view when its conversation disappears", async () => {
  const { env, session } = await settledConversation();
  const { failure } = watching(env, session.id);
  await vi.advanceTimersByTimeAsync(100);
  env.fake.sessions.delete(session.id);
  await vi.advanceTimersByTimeAsync(5_500);
  expect(await failure).toMatchObject({ code: Code.NotFound });
});

function runningConversation(env: Environment) {
  const session = env.fake.createSession(agent, "running-conversation", "Running");
  return { session, task: conversationTask(env, "running-task", session.id, TaskState.WORKING) };
}

function delta(env: Environment, task: Task, text: string) {
  task.artifacts = [
    create(ArtifactSchema, {
      artifactId: "answer",
      parts: [{ content: { case: "text", value: text } }],
    }),
  ];
  env.fake.update(task, TaskState.WORKING);
}

it("carries text deltas from the live stream between catalog reads", async () => {
  const env = await environment();
  const { session, task } = runningConversation(env);
  const { views } = watching(env, session.id);
  await vi.advanceTimersByTimeAsync(300);
  const initial = reads(env, TaskCatalogView.DETAILS);
  for (const text of ["first", "second", "third"]) {
    delta(env, task, text);
    await vi.advanceTimersByTimeAsync(300);
  }
  expect(reads(env, TaskCatalogView.DETAILS)).toBe(initial);
  expect(texts(views).at(-1)).toBe("third");
  delta(env, task, "fourth");
  await vi.advanceTimersByTimeAsync(1_500);
  delta(env, task, "fifth");
  await vi.advanceTimersByTimeAsync(300);
  expect(reads(env, TaskCatalogView.DETAILS)).toBe(initial + 1);
  expect(texts(views).at(-1)).toBe("fifth");
});

it("rereads the catalog as soon as a followed task changes state", async () => {
  const env = await environment();
  const { session, task } = runningConversation(env);
  const { views } = watching(env, session.id);
  await vi.advanceTimersByTimeAsync(300);
  const initial = reads(env, TaskCatalogView.DETAILS);
  env.fake.update(task, TaskState.COMPLETED);
  await vi.advanceTimersByTimeAsync(300);
  expect(reads(env, TaskCatalogView.DETAILS)).toBe(initial + 1);
  expect(views.length).toBeGreaterThan(0);
});
