import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { createValidateInterceptor } from "@connectrpc/validate";
import postgres from "postgres";
import { afterEach, beforeEach, expect } from "vitest";
import {
  ChangeControlService,
  ChangeRequestSchema,
  ChangeState,
  EnvironmentSchema,
  Governance,
} from "../gen/agentos/governance/v1/change_pb.js";
import { Zammad } from "../server/change-control/providers/zammad/api.js";
import { ZammadApprovals } from "../server/change-control/providers/zammad/approvals.js";
import { changeControl } from "../server/change-control/service.js";
import { ChangeStore } from "../server/change-control/store.js";
import { fakeZammad } from "./fake-zammad.js";
import { fixtureCatalog } from "./harness.js";

function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}

export const database = process.env.CHANGE_TEST_DATABASE_URL;

export function changeFixture() {
  let admin: postgres.Sql, schema: string, store: ChangeStore;
  let api: Awaited<ReturnType<typeof fakeZammad>>;
  beforeEach(async () => {
    admin = postgres(present(database));
    schema = `qa_${randomUUID().replaceAll("-", "")}`;
    await admin`CREATE SCHEMA ${admin(schema)}`;
    const url = new URL(present(database));
    url.searchParams.set("options", `-c search_path=${schema}`);
    store = new ChangeStore(url.toString());
    await store.initialize();
    api = await fakeZammad();
  });
  afterEach(async () => {
    await store.close();
    await api.close();
    await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    await admin.end();
  });
  function setup(governance = Governance.APPROVAL) {
    const direct = governance === Governance.DIRECT;
    const name = direct ? "lab-sim" : "lab-real";
    const control = changeControl(
      store,
      new ZammadApprovals(new Zammad(api.url, "coordinator"), direct ? 8 : 7, api.url),
      create(EnvironmentSchema, { name, governance, approvalUrl: api.url }),
      fixtureCatalog(),
    );
    const client = createClient(
      ChangeControlService,
      createRouterTransport((router) => router.service(ChangeControlService, control.rpc), {
        router: { interceptors: [createValidateInterceptor()] },
      }),
    );
    const request = create(ChangeRequestSchema, {
      engineer: "remediation",
      taskId: randomUUID(),
      contextId: randomUUID(),
      requestId: "native-approval",
      tool: {
        id: "approval-id",
        callId: "call-id",
        name: `${name}-kubernetes_resources_create_or_update`,
        args: { resource: "test-configmap", namespace: "agentos-lab" },
      },
      intent: "Create a disposable verification ConfigMap",
      prompt: "Validate the work-order execution path",
    });
    return { client, control, request };
  }
  async function approved(prepare = true) {
    const env = setup(),
      { result } = await env.client.registerChange({ request: env.request });
    expect(result?.change?.state).toBe(ChangeState.PENDING);
    api.decide(Number(present(present(result).change).ticketId), "approved", 3);
    const { result: ready } = await env.client.getChange({
      id: present(present(result).change).id,
    });
    if (prepare) await env.client.prepareExecution({ id: present(present(ready).change).id });
    return { ...env, ready: present(ready) };
  }
  return {
    setup,
    approved,
    get api() {
      return api;
    },
    get store() {
      return store;
    },
    get admin() {
      return admin;
    },
    get schema() {
      return schema;
    },
  };
}
