import { randomBytes, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import postgres from "postgres";
import { expect, it } from "vitest";
import {
  ExecutionBindingSchema,
  ExecutionIdentitySchema,
} from "../gen/agentos/execution/v1/identity_pb.js";
import { executionStore } from "../server/authorization/store.js";

it.skipIf(!process.env.CHANGE_TEST_DATABASE_URL)(
  "persists encrypted protobufs with CAS and authenticates the workspace, record ID and encryption key",
  async () => {
    const uri = process.env.CHANGE_TEST_DATABASE_URL ?? "";
    const workspace = `execution-test-${randomUUID()}`,
      key = randomBytes(32);
    const sql = postgres(uri),
      store = await executionStore(uri, key, workspace);
    const jwt = "private-user-credential";
    let restarted: Awaited<ReturnType<typeof executionStore>> | undefined;
    try {
      const identity = create(ExecutionIdentitySchema, {
        subject: "alice",
        write: true,
        credential: { case: "accessToken", value: jwt },
        refreshToken: "offline-private-refresh",
      });
      await store.saveIdentity(identity);
      const saved = await store.identity("alice");
      expect(saved?.value).toEqual(identity);
      const rows =
        await sql`select value from agentos_authorization.objects where workspace=${workspace}`;
      expect(Buffer.from(rows[0].value).includes(Buffer.from(jwt))).toBe(false);
      expect(Buffer.from(rows[0].value).includes(Buffer.from(identity.refreshToken))).toBe(false);
      await store.close();
      restarted = await executionStore(uri, key, workspace);
      expect((await restarted.identity("alice"))?.value).toEqual(identity);
      identity.write = false;
      await restarted.saveIdentity(identity, saved?.version);
      await expect(restarted.saveIdentity(identity, saved?.version)).rejects.toMatchObject({
        code: Code.Aborted,
      });
      await expect(restarted.saveIdentity(identity)).rejects.toMatchObject({ code: Code.Aborted });
      const replica = await executionStore(uri, key, workspace);
      try {
        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            (index % 2 ? replica : restarted)?.updateIdentity("alice", async (current) => {
              const generation = Number(current.refreshToken.match(/-(\d+)$/)?.[1] ?? 0);
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { ...current, refreshToken: `rotated-${generation + 1}` };
            }),
          ),
        );
        expect((await replica.identity("alice"))?.value.refreshToken).toBe("rotated-8");
      } finally {
        await replica.close();
      }
      const binding = create(ExecutionBindingSchema, {
        sessionId: "one",
        rootSessionId: "one",
        subject: "alice",
        agent: { namespace: workspace, name: "assistant" },
      });
      await restarted.saveBinding(binding);
      expect(await restarted.bindings(["one", "missing"])).toEqual([binding]);
      await sql`insert into agentos_authorization.objects(workspace,kind,id,value)
      select workspace,kind,'two',value from agentos_authorization.objects where workspace=${workspace} and id='one'`;
      await expect(restarted.binding("two")).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(restarted.bindings(["two"])).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      const wrong = await executionStore(uri, randomBytes(32), workspace);
      try {
        await expect(wrong.identity("alice")).rejects.toMatchObject({
          code: Code.PermissionDenied,
        });
      } finally {
        await wrong.close();
      }
      const isolated = await executionStore(uri, key, `${workspace}-other`);
      try {
        expect(await isolated.identity("alice")).toBeUndefined();
      } finally {
        await isolated.close();
      }
    } finally {
      await sql`delete from agentos_authorization.objects where workspace=${workspace}`;
      await Promise.all([sql.end(), restarted?.close(), store.close()]);
    }
  },
);
