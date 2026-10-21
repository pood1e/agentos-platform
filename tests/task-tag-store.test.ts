import { randomUUID } from "node:crypto";
import { Code } from "@connectrpc/connect";
import postgres from "postgres";
import { expect, it } from "vitest";
import { taskTagStore } from "../server/tasks/store.js";

it.skipIf(!process.env.CHANGE_TEST_DATABASE_URL)(
  "persists task tags across restarts, isolates workspaces and atomically rejects concurrent writes",
  async () => {
    const uri = process.env.CHANGE_TEST_DATABASE_URL ?? "";
    const workspace = `tags-test-${randomUUID()}`;
    const sql = postgres(uri);
    const first = await taskTagStore(uri, workspace);
    const second = await taskTagStore(uri, workspace);
    const other = await taskTagStore(uri, `${workspace}-other`);
    try {
      expect(await first.read([])).toEqual(new Map());
      const writes = await Promise.allSettled([
        first.save("one", ["analysis"], "0"),
        second.save("one", ["maintenance"], "0"),
      ]);
      expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(writes.filter((result) => result.status === "rejected")).toMatchObject([
        { reason: { code: Code.Aborted } },
      ]);
      const record = (await first.read(["one", "missing"])).get("one");
      expect(record?.tagsVersion).toBe("1");
      expect(await other.read(["one"])).toEqual(new Map());
      await first.close();
      expect((await second.read(["one"])).get("one")).toEqual(record);
      await second.save("one", [], "1");
      await expect(second.save("one", ["stale"], "0")).rejects.toMatchObject({
        code: Code.Aborted,
      });
      await expect(second.save("one", ["stale"], "1")).rejects.toMatchObject({
        code: Code.Aborted,
      });
      expect((await second.read(["one"])).get("one")).toEqual({ tags: [], tagsVersion: "2" });
    } finally {
      await sql`delete from agentos_console.task_tags where workspace=${workspace}`;
      await Promise.all([first.close(), second.close(), other.close(), sql.end()]);
    }
  },
);
