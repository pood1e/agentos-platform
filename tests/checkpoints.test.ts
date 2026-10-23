import { expect, it, vi } from "vitest";
import { Checkpoints } from "../server/read-model/checkpoints.js";
import { environment } from "./harness.js";

it("replays unacknowledged changes without advancing native listing progress", async () => {
  const { sync, index, clients } = environment();
  const batches: string[][] = [];
  let unavailable = true;
  const list = vi.spyOn(clients.a2a, "listTasks");
  index.onCheckpoint(async (ids) => {
    batches.push([...ids]);
    if (unavailable) throw new Error("database unavailable");
  });
  try {
    await expect(sync.refresh()).rejects.toThrow("database unavailable");
    unavailable = false;
    const first = list.mock.calls.length;
    await sync.refresh();
    expect(batches[1]).toEqual(batches[0]);
    expect(list.mock.calls.slice(first).every(([request]) => !request.statusTimestampAfter)).toBe(
      true,
    );
    await sync.refresh();
    expect(batches).toHaveLength(2);
    expect(list.mock.calls.some(([request]) => request.statusTimestampAfter)).toBe(true);
  } finally {
    sync.close();
  }
});

it("keeps changes made during an in-flight checkpoint for the following commit", async () => {
  const checkpoints = new Checkpoints();
  let announce: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batches: string[][] = [];
  checkpoints.subscribe(async (ids) => {
    batches.push([...ids]);
    if (batches.length === 1) {
      announce();
      await blocked;
    }
  });
  checkpoints.touch("same");
  const first = checkpoints.commit();
  await started;
  checkpoints.touch("same");
  checkpoints.touch("new");
  release();
  await first;
  await checkpoints.commit();
  expect(batches).toEqual([["same"], ["same", "new"]]);
});
