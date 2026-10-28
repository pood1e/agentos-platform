import { randomUUID } from "node:crypto";
import { Code } from "@connectrpc/connect";
import postgres from "postgres";
import { expect, onTestFinished, it as test } from "vitest";
import { commandLocks } from "../server/read-model/commands.js";
import { advisoryLease } from "../server/shared/lease.js";

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

it("elects one reconciler and hands over after a lost session or shutdown", async () => {
  const name = `agentos_reconcile:${randomUUID()}`;
  const admin = replica();
  const database = { uri: process.env.CHANGE_TEST_DATABASE_URL ?? "" };
  const first = advisoryLease(database, name),
    second = advisoryLease(database, name);
  onTestFinished(async () => {
    await Promise.all([first.release(), second.release()]);
  });
  expect(await first.held()).toBe(true);
  expect(await second.held()).toBe(false);
  expect(await first.held()).toBe(true);
  await admin`select pg_terminate_backend(pid, 1000) from pg_locks
    where locktype = 'advisory' and granted and objsubid = 1
      and ((classid::int8 << 32) | objid::int8) = hashtextextended(${name}, 0)`;
  // The terminated session lost the lock; its replica reconnects as a standby.
  expect(await second.held()).toBe(true);
  expect(await first.held()).toBe(false);
  expect(await second.held()).toBe(true);
  await second.release();
  expect(await first.held()).toBe(true);
});
