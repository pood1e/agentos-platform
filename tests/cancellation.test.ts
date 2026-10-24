import { clone, create } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { cancellationCommands } from "../server/console/cancellation.js";
import { parentTaskKey } from "../server/read-model/decode/messages.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment } from "./harness.js";

const identity = create(ExecutionIdentitySchema, { subject: "cancel-owner" });

it("drains a delegated task accepted while its caller is being canceled", async () => {
  const { clients, sync, fake, index } = environment();
  fake.update(fake.task(ids.dispatchRoot), TaskState.WORKING);
  await sync.refresh();
  const native = clients.a2a.cancelTask;
  vi.spyOn(clients.a2a, "cancelTask").mockImplementation(async (request, options) => {
    const result = await native(request, options);
    if (request.id === ids.dispatchRoot) {
      const late = clone(TaskSchema, fake.task(ids.inspection));
      late.id = "late-worker";
      late.history = [
        create(MessageSchema, {
          messageId: "late-input",
          role: Role.USER,
          metadata: { [parentTaskKey]: ids.dispatchRoot },
        }),
      ];
      late.artifacts = [];
      fake.update(late, TaskState.WORKING);
    }
    return result;
  });
  try {
    await cancellationCommands(sync, clients)(
      ids.dispatchRoot,
      identity,
      new AbortController().signal,
    );
    expect(fake.task("late-worker").status?.state).toBe(TaskState.CANCELED);
    expect(index.entry("late-worker")?.state).toBe(TaskState.CANCELED);
  } finally {
    sync.close();
  }
});

it("stops background work from an earlier turn when the latest turn has already finished", async () => {
  const { clients, sync, fake, index } = environment();
  fake.update(fake.task(ids.background), TaskState.WORKING);
  const latest = clone(TaskSchema, fake.task(ids.dispatchRoot));
  latest.id = "completed-later-turn";
  latest.artifacts = [];
  latest.history = [create(MessageSchema, { messageId: "later-input", role: Role.USER })];
  fake.update(latest, TaskState.COMPLETED);
  await sync.refresh();
  try {
    await cancellationCommands(sync, clients)(latest.id, identity, new AbortController().signal);
    expect(fake.task(ids.background).status?.state).toBe(TaskState.CANCELED);
    expect(index.entry(latest.id)?.state).toBe(TaskState.COMPLETED);
  } finally {
    sync.close();
  }
});
