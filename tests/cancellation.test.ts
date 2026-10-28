import { expect, it, vi } from "vitest";
import { TaskState } from "../gen/a2a_pb.js";
import { cancellationCommands } from "../server/console/cancellation.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { environment, operator } from "./harness.js";

it("sends one native cancellation for the operation root, including a selected child", async () => {
  const env = await environment();
  env.fake.update(env.fake.task(ids.dispatchRoot), TaskState.WORKING);
  const cancel = vi.spyOn(env.clients.a2a, "cancelTask");
  await cancellationCommands(env.projection, env.clients)(
    ids.inspection,
    operator,
    new AbortController().signal,
  );
  expect(cancel).toHaveBeenCalledExactlyOnceWith(
    { id: ids.dispatchRoot, tenant: "agentos/coordinator" },
    expect.objectContaining({ timeoutMs: 30_000 }),
  );
  await env.close();
});

it("propagates native cancellation failure without running a platform cancellation loop", async () => {
  const env = await environment();
  const cancel = vi
    .spyOn(env.clients.a2a, "cancelTask")
    .mockRejectedValue(new Error("native cancellation failed"));
  await expect(
    cancellationCommands(env.projection, env.clients)(
      ids.dispatchRoot,
      operator,
      new AbortController().signal,
    ),
  ).rejects.toThrow("native cancellation failed");
  expect(cancel).toHaveBeenCalledOnce();
  await env.close();
});
