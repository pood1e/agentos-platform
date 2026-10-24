import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { afterEach, expect, it, vi } from "vitest";
import { MessageSchema, Role } from "../gen/a2a_pb.js";
import { FakeKagent } from "./fake-kagent/kagent.js";
import { fixtureAgents } from "./fixtures/kagent.js";

afterEach(() => vi.useRealTimers());

it("cancels old scenario work when its execution bindings are replaced", async () => {
  vi.useFakeTimers();
  const fake = new FakeKagent({ agents: fixtureAgents(), sessions: [], tasks: [] });
  const parent = fake.createSession(
    { namespace: "agentos", name: "assistant" },
    randomUUID(),
    "old scenario",
  );
  let rejectBinding: (error: Error) => void = () => {
    throw new Error("Binding was not started");
  };
  fake.executionCreated = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectBinding = reject;
      }),
  );
  fake.accept(
    create(MessageSchema, {
      messageId: randomUUID(),
      contextId: parent.id,
      role: Role.USER,
      parts: [{ content: { case: "text", value: "create ConfigMap" } }],
    }),
  );
  await vi.advanceTimersByTimeAsync(200);
  expect(fake.executionCreated).toHaveBeenCalledOnce();
  fake.load({ sessions: [], tasks: [] });
  rejectBinding(new Error("Old execution bindings were removed"));
  await vi.advanceTimersByTimeAsync(200);
  expect(fake.tasks.size).toBe(0);
  expect(fake.sessions.size).toBe(0);
});
