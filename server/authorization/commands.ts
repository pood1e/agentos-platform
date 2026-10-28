import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import { conflict } from "../shared/errors.js";

/**
 * Rejects overlapping commands on one conversation or task across API replicas.
 * Each lock lives in its own transaction, so it ends with the command or its connection.
 */
export function commandLocks(sql: postgres.Sql, workspace: string) {
  const held = new AsyncLocalStorage<postgres.TransactionSql>();
  async function acquire(tx: postgres.TransactionSql, key: string) {
    const [row] = await tx`select pg_try_advisory_xact_lock(
      hashtextextended(${`agentos_command:${workspace}:${key}`}, 0)) as locked`;
    if (!row?.locked) throw conflict("chat.busy");
  }
  return async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    // Nested commands share the outer transaction instead of waiting for another connection.
    const outer = held.getStore();
    if (outer) {
      await acquire(outer, key);
      return run();
    }
    let outcome: { value: T } | undefined;
    try {
      await sql.begin(async (tx) => {
        await acquire(tx, key);
        outcome = { value: await held.run(tx, run) };
      });
    } catch (error) {
      // A commit lost after the command completed has released the lock as well.
      if (!outcome) throw error;
    }
    return (outcome as { value: T }).value;
  };
}
