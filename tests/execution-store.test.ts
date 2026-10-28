import { randomBytes, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import postgres from "postgres";
import { expect, it } from "vitest";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import {
  ExecutionBindingSchema,
  ExecutionIdentitySchema,
} from "../gen/agentos/execution/v1/identity_pb.js";
import { executionStore } from "../server/authorization/store.js";

it.skipIf(!process.env.CHANGE_TEST_DATABASE_URL)(
  "keeps bindings queryable, encrypts tokens per subject and rejects swapped or foreign ciphertexts",
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
        capabilities: [Capability.MODELS_MANAGE],
        credential: { case: "accessToken", value: jwt },
        refreshToken: "offline-private-refresh",
      });
      await store.saveIdentity(identity);
      const saved = await store.identity("alice");
      expect(saved?.value).toEqual(identity);
      const [row] = await sql`select tokens, capabilities from agentos_authorization.credentials
        where workspace=${workspace} and subject='alice'`;
      expect(row?.capabilities).toEqual([Capability.MODELS_MANAGE]);
      expect(Buffer.from(row?.tokens).includes(Buffer.from(jwt))).toBe(false);
      expect(Buffer.from(row?.tokens).includes(Buffer.from(identity.refreshToken))).toBe(false);
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

      const agent = { namespace: workspace, name: "assistant" };
      const binding = (sessionId: string, parentSessionId = "") =>
        create(ExecutionBindingSchema, {
          sessionId,
          parentSessionId,
          rootSessionId: "root",
          subject: "alice",
          agent,
          capabilities: [Capability.MODELS_MANAGE],
        });
      for (const value of [binding("root"), binding("child", "root"), binding("leaf", "child")])
        await restarted.saveBinding(value);
      expect((await restarted.chain("leaf")).map((item) => item.sessionId)).toEqual([
        "leaf",
        "child",
        "root",
      ]);
      expect(await restarted.bindings(["child", "missing"])).toEqual([binding("child", "root")]);
      await restarted.saveBinding(binding("orphan", "absent"));
      expect((await restarted.chain("orphan")).map((item) => item.sessionId)).toEqual(["orphan"]);

      await restarted.saveIdentity(
        create(ExecutionIdentitySchema, {
          subject: "bob",
          credential: { case: "accessToken", value: "bob-credential" },
        }),
      );
      await sql`update agentos_authorization.credentials set tokens=(
          select tokens from agentos_authorization.credentials
          where workspace=${workspace} and subject='alice')
        where workspace=${workspace} and subject='bob'`;
      await expect(restarted.identity("bob")).rejects.toMatchObject({
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
        expect(await isolated.chain("leaf")).toEqual([]);
      } finally {
        await isolated.close();
      }
    } finally {
      await sql`delete from agentos_authorization.credentials where workspace=${workspace}`;
      await sql`delete from agentos_authorization.execution_bindings where workspace=${workspace}`;
      await Promise.all([sql.end(), restarted?.close(), store.close()]);
    }
  },
);
