import { randomUUID } from "node:crypto";
import { Code } from "@connectrpc/connect";
import postgres from "postgres";
import { expect, onTestFinished, it as test } from "vitest";
import { commandLocks } from "../server/authorization/commands.js";

const it = test.skipIf(!process.env.CHANGE_TEST_DATABASE_URL);

function replica() {
  const sql = postgres(process.env.CHANGE_TEST_DATABASE_URL ?? "", { max: 2, onnotice: () => {} });
  onTestFinished(() => sql.end({ timeout: 1 }));
  return sql;
}

it("rejects overlapping commands on one conversation across API replicas", async () => {
  const workspace = randomUUID();
  const first = commandLocks(replica(), workspace),
    second = commandLocks(replica(), workspace);
  let acquired = () => {},
    finish = () => {};
  const started = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const held = first("conversation", async () => {
    acquired();
    await gate;
  });
  await started;
  await expect(second("conversation", async () => "late")).rejects.toMatchObject({
    code: Code.Aborted,
  });
  expect(await second("other", async () => "independent")).toBe("independent");
  finish();
  await held;
  expect(await second("conversation", async () => "after")).toBe("after");
  expect(await first("message", () => first("session", async () => "nested"))).toBe("nested");
  await expect(
    first("conversation", async () => {
      throw new Error("dispatch failed");
    }),
  ).rejects.toThrow("dispatch failed");
  expect(await second("conversation", async () => "released")).toBe("released");
});
